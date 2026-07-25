// Uniswap V3 liquidity-position management, Ethereum Sepolia only.
//
// This is a *different* Uniswap service from the one `trading` talks to. `trading` uses the
// Trading API (trade-api.gateway.uniswap.org/v1) for swaps; liquidity provisioning lives behind
// the Liquidity API (liquidity.api.uniswap.org, UNISWAP_LP_API_URL). Both authenticate with the
// same UNISWAP_API_KEY.
//
// Position *reads* here never touch either API — they are plain eth_call against the canonical
// V3 deployment, so `get_v3_position` works with nothing but an RPC endpoint.
//
// Scope is deliberately narrow: V3 only, Sepolia only, existing pools only. Any other chainId is
// rejected up front rather than silently sent to an API that would price it against the wrong
// deployment.

use std::sync::OnceLock;

use alloy::{
    dyn_abi::{DynSolValue, FunctionExt, JsonAbiExt},
    json_abi::{Function, JsonAbi},
    primitives::{Address, B256, Bytes, Log as PrimitiveLog, U256, address, b256},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
};
use anyhow::{Context, Result};
use rmcp::model::*;
use serde_json::{Map, Value, json};

use super::UniswapMcpServer;
use super::common::{parse_flexible_u256, wait_for_receipt};
use crate::{
    db::DbPool,
    vault::sign_transaction::{SignTransactionParams, resolve_agent_address, sign_transaction},
};

// ---------------------------------------------------------------------------
// Sepolia V3 deployment
//
// Addresses verified on-chain (2026-07-25) rather than copied from a doc page:
//   NonfungiblePositionManager.name()    == "Uniswap V3 Positions NFT-V1"
//   NonfungiblePositionManager.factory() == 0x0227628f3F023bb0B980b67D528571c95c6DaC1c
//
// Note for anyone cross-checking against older notes: 0x3B5E3c5E595D85fbFBC2a42ECC091e183E76697C
// is sometimes quoted as the Sepolia position manager. It is not — on-chain it is a Solidity
// library (its bytecode is the PUSH20-self-address preamble) and ownerOf/positions revert on it.
//
// WETH verified the same way: symbol() == "WETH", decimals() == 18. It is the canonical wrapper
// every Sepolia V3 pool pairs against — a V3 pool has no native-ETH side, so "ETH" in a tool
// argument always means this contract by the time it reaches a pool or the Liquidity API.
// ---------------------------------------------------------------------------

pub struct SepoliaV3Deployment {
    pub chain_id: u64,
    pub factory: Address,
    pub position_manager: Address,
    pub weth: Address,
}

pub const SEPOLIA_V3: SepoliaV3Deployment = SepoliaV3Deployment {
    chain_id: 11155111,
    factory: address!("0227628f3F023bb0B980b67D528571c95c6DaC1c"),
    position_manager: address!("1238536071E1c677A632429e3655c799b22cDA52"),
    weth: address!("fFf9976782d46CC05630D1f6eBAb18b2324d6B14"),
};

// ---------------------------------------------------------------------------
// Minimal ABI fragments
//
// Only the functions actually called. Parsed once into alloy's JsonAbi so encoding/decoding goes
// through the same machinery as the ABI-driven EvmMcpServer (abi_codec) instead of hand-rolled
// selectors — in particular `positions()`' 12-field return is decoded by name, not by offset.
// ---------------------------------------------------------------------------

const POSITION_MANAGER_ABI: &str = r#"[
  {"name":"ownerOf","type":"function","stateMutability":"view",
   "inputs":[{"name":"tokenId","type":"uint256"}],
   "outputs":[{"name":"owner","type":"address"}]},
  {"name":"balanceOf","type":"function","stateMutability":"view",
   "inputs":[{"name":"owner","type":"address"}],
   "outputs":[{"name":"balance","type":"uint256"}]},
  {"name":"tokenOfOwnerByIndex","type":"function","stateMutability":"view",
   "inputs":[{"name":"owner","type":"address"},{"name":"index","type":"uint256"}],
   "outputs":[{"name":"tokenId","type":"uint256"}]},
  {"name":"positions","type":"function","stateMutability":"view",
   "inputs":[{"name":"tokenId","type":"uint256"}],
   "outputs":[
     {"name":"nonce","type":"uint96"},
     {"name":"operator","type":"address"},
     {"name":"token0","type":"address"},
     {"name":"token1","type":"address"},
     {"name":"fee","type":"uint24"},
     {"name":"tickLower","type":"int24"},
     {"name":"tickUpper","type":"int24"},
     {"name":"liquidity","type":"uint128"},
     {"name":"feeGrowthInside0LastX128","type":"uint256"},
     {"name":"feeGrowthInside1LastX128","type":"uint256"},
     {"name":"tokensOwed0","type":"uint128"},
     {"name":"tokensOwed1","type":"uint128"}]}
]"#;

const FACTORY_ABI: &str = r#"[
  {"name":"getPool","type":"function","stateMutability":"view",
   "inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},
             {"name":"fee","type":"uint24"}],
   "outputs":[{"name":"pool","type":"address"}]}
]"#;

const POOL_ABI: &str = r#"[
  {"name":"token0","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"address"}]},
  {"name":"token1","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"address"}]},
  {"name":"fee","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"uint24"}]},
  {"name":"tickSpacing","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"int24"}]},
  {"name":"liquidity","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"uint128"}]},
  {"name":"slot0","type":"function","stateMutability":"view","inputs":[],
   "outputs":[
     {"name":"sqrtPriceX96","type":"uint160"},
     {"name":"tick","type":"int24"},
     {"name":"observationIndex","type":"uint16"},
     {"name":"observationCardinality","type":"uint16"},
     {"name":"observationCardinalityNext","type":"uint16"},
     {"name":"feeProtocol","type":"uint8"},
     {"name":"unlocked","type":"bool"}]}
]"#;

/// The parts of ERC-20 this module needs: `decimals()` to convert human amounts exactly, and
/// `balanceOf` to size a position against what the wallet actually holds. WETH is an ERC-20, so
/// this covers the wrapped side too — only `deposit()` needs a fragment of its own.
const ERC20_ABI: &str = r#"[
  {"name":"decimals","type":"function","stateMutability":"view","inputs":[],
   "outputs":[{"name":"","type":"uint8"}]},
  {"name":"balanceOf","type":"function","stateMutability":"view",
   "inputs":[{"name":"account","type":"address"}],
   "outputs":[{"name":"","type":"uint256"}]}
]"#;

/// `deposit()` is WETH's own extension, not part of ERC-20 — wrapping native ETH is the one
/// thing the standard fragment cannot express.
const WETH_ABI: &str = r#"[
  {"name":"deposit","type":"function","stateMutability":"payable","inputs":[],"outputs":[]}
]"#;

fn parse_abi(src: &str, what: &str) -> JsonAbi {
    serde_json::from_str(src).unwrap_or_else(|e| panic!("built-in {what} ABI is malformed: {e}"))
}

fn position_manager_abi() -> &'static JsonAbi {
    static ABI: OnceLock<JsonAbi> = OnceLock::new();
    ABI.get_or_init(|| parse_abi(POSITION_MANAGER_ABI, "NonfungiblePositionManager"))
}

fn factory_abi() -> &'static JsonAbi {
    static ABI: OnceLock<JsonAbi> = OnceLock::new();
    ABI.get_or_init(|| parse_abi(FACTORY_ABI, "UniswapV3Factory"))
}

fn pool_abi() -> &'static JsonAbi {
    static ABI: OnceLock<JsonAbi> = OnceLock::new();
    ABI.get_or_init(|| parse_abi(POOL_ABI, "UniswapV3Pool"))
}

fn erc20_abi() -> &'static JsonAbi {
    static ABI: OnceLock<JsonAbi> = OnceLock::new();
    ABI.get_or_init(|| parse_abi(ERC20_ABI, "ERC20"))
}

fn weth_abi() -> &'static JsonAbi {
    static ABI: OnceLock<JsonAbi> = OnceLock::new();
    ABI.get_or_init(|| parse_abi(WETH_ABI, "WETH9"))
}

fn abi_function<'a>(abi: &'a JsonAbi, name: &str) -> Result<&'a Function> {
    abi.function(name)
        .and_then(|fs| fs.first())
        .ok_or_else(|| anyhow::anyhow!("built-in ABI has no function '{name}'"))
}

/// eth_call a view function and return its decoded outputs.
async fn call_view(
    provider: &impl Provider,
    to: Address,
    func: &Function,
    args: &[DynSolValue],
) -> Result<Vec<DynSolValue>> {
    let calldata = func
        .abi_encode_input(args)
        .with_context(|| format!("failed to encode {} calldata", func.name))?;

    let raw = provider
        .call(TransactionRequest::default().to(to).input(calldata.into()))
        .await
        .with_context(|| format!("eth_call {}({to:#x}) failed", func.name))?;

    func.abi_decode_output(&raw)
        .with_context(|| format!("failed to decode {} output", func.name))
}

// ─── typed extraction from decoded outputs ───────────────────────────────────

fn out<'a>(vals: &'a [DynSolValue], idx: usize, what: &str) -> Result<&'a DynSolValue> {
    vals.get(idx)
        .ok_or_else(|| anyhow::anyhow!("missing output {idx} ({what})"))
}

fn as_address(v: &DynSolValue, what: &str) -> Result<Address> {
    v.as_address()
        .ok_or_else(|| anyhow::anyhow!("expected {what} to decode as an address"))
}

fn as_u256(v: &DynSolValue, what: &str) -> Result<U256> {
    v.as_uint()
        .map(|(n, _)| n)
        .ok_or_else(|| anyhow::anyhow!("expected {what} to decode as an unsigned integer"))
}

fn as_u32(v: &DynSolValue, what: &str) -> Result<u32> {
    let n = as_u256(v, what)?;
    u32::try_from(n).with_context(|| format!("{what} does not fit in u32"))
}

fn as_i32(v: &DynSolValue, what: &str) -> Result<i32> {
    let (n, _) = v
        .as_int()
        .ok_or_else(|| anyhow::anyhow!("expected {what} to decode as a signed integer"))?;
    i32::try_from(n).with_context(|| format!("{what} does not fit in i32"))
}

// ---------------------------------------------------------------------------
// Position and pool reads
// ---------------------------------------------------------------------------

/// A V3 position as reported by NonfungiblePositionManager.positions(), plus the pool it
/// belongs to (resolved through the factory rather than trusted from anywhere else).
pub struct V3Position {
    pub token0: Address,
    pub token1: Address,
    pub fee: u32,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: U256,
    pub tokens_owed0: U256,
    pub tokens_owed1: U256,
    pub pool: Address,
}

/// Pulls the fields we care about out of a decoded `positions()` return.
///
/// `positions()` returns twelve unnamed-at-the-wire values, so this is where the ABI fragment's
/// field order is actually load-bearing: read an index wrong and you get a plausible-looking
/// address or tick that belongs to a different field. Split out from `read_v3_position` so it
/// can be tested against a real on-chain return blob with no RPC.
///
/// `pool` is left zero — only `read_v3_position` can fill it, since resolving it needs the
/// token0/token1/fee this function has just decoded.
fn decode_positions(p: &[DynSolValue]) -> Result<V3Position> {
    Ok(V3Position {
        token0: as_address(out(p, 2, "positions.token0")?, "positions.token0")?,
        token1: as_address(out(p, 3, "positions.token1")?, "positions.token1")?,
        fee: as_u32(out(p, 4, "positions.fee")?, "positions.fee")?,
        tick_lower: as_i32(out(p, 5, "positions.tickLower")?, "positions.tickLower")?,
        tick_upper: as_i32(out(p, 6, "positions.tickUpper")?, "positions.tickUpper")?,
        liquidity: as_u256(out(p, 7, "positions.liquidity")?, "positions.liquidity")?,
        tokens_owed0: as_u256(
            out(p, 10, "positions.tokensOwed0")?,
            "positions.tokensOwed0",
        )?,
        tokens_owed1: as_u256(
            out(p, 11, "positions.tokensOwed1")?,
            "positions.tokensOwed1",
        )?,
        pool: Address::ZERO,
    })
}

/// Reads the position NFT, rejecting it unless `owner` currently holds it, then resolves the
/// pool through the factory.
///
/// The ownership check is the authorization boundary for every LP write tool: the Liquidity API
/// will happily build a transaction against a tokenId the caller doesn't own, and it would then
/// revert on-chain after costing gas. Checking here fails before any funds move.
async fn read_v3_position(
    provider: &impl Provider,
    nft_token_id: U256,
    owner: Address,
) -> Result<V3Position> {
    let pm_abi = position_manager_abi();
    let pm = SEPOLIA_V3.position_manager;
    let token_id_arg = [DynSolValue::Uint(nft_token_id, 256)];

    let owner_out = call_view(
        provider,
        pm,
        abi_function(pm_abi, "ownerOf")?,
        &token_id_arg,
    )
    .await
    .with_context(|| {
        format!("reading ownerOf({nft_token_id}) failed — does position NFT {nft_token_id} exist?")
    })?;
    let actual_owner = as_address(out(&owner_out, 0, "ownerOf.owner")?, "ownerOf.owner")?;

    anyhow::ensure!(
        actual_owner == owner,
        "position NFT {nft_token_id} is owned by {actual_owner:#x}, not by this agent's wallet \
         {owner:#x} — refusing to act on a position the agent does not hold"
    );

    let p = call_view(
        provider,
        pm,
        abi_function(pm_abi, "positions")?,
        &token_id_arg,
    )
    .await?;

    let mut position = decode_positions(&p)?;

    position.pool = get_pool(provider, position.token0, position.token1, position.fee).await?;
    anyhow::ensure!(
        !position.pool.is_zero(),
        "factory has no V3 pool for {:#x}/{:#x} at fee tier {}",
        position.token0,
        position.token1,
        position.fee
    );

    Ok(position)
}

async fn get_pool(
    provider: &impl Provider,
    token_a: Address,
    token_b: Address,
    fee: u32,
) -> Result<Address> {
    let outs = call_view(
        provider,
        SEPOLIA_V3.factory,
        abi_function(factory_abi(), "getPool")?,
        &[
            DynSolValue::Address(token_a),
            DynSolValue::Address(token_b),
            DynSolValue::Uint(U256::from(fee), 24),
        ],
    )
    .await?;

    as_address(out(&outs, 0, "getPool.pool")?, "getPool.pool")
}

/// Everything about a pool that position sizing and range derivation need, read from the pool
/// itself and verified against the factory.
pub struct V3PoolState {
    pub token0: Address,
    pub token1: Address,
    pub fee: u32,
    pub tick_spacing: i32,
    pub current_tick: i32,
    pub sqrt_price_x96: U256,
    pub liquidity: U256,
}

/// Reads a pool's pair, fee tier, current price/tick, tick spacing and active liquidity, then
/// proves the address really is a V3 pool from the canonical Sepolia factory by round-tripping it
/// through `getPool`.
///
/// The factory round-trip is what lets `create_v3_position` take a pool (or none at all) instead
/// of caller-supplied token addresses: the pair it will approve spending on is derived from a
/// pool the factory vouches for, rather than asserted alongside it. Taking both from the caller
/// would let a model pair a real pool with unrelated token addresses and get approvals issued for
/// the wrong assets. An arbitrary contract that merely answers token0()/token1()/fee() fails the
/// round-trip.
///
/// `current_tick`/`tick_spacing` are read here rather than left to the caller because deriving a
/// price range needs both, and an agent has no good way to obtain them otherwise.
async fn read_v3_pool_state(provider: &impl Provider, pool: Address) -> Result<V3PoolState> {
    let abi = pool_abi();

    let t0 = call_view(provider, pool, abi_function(abi, "token0")?, &[])
        .await
        .with_context(|| format!("{pool:#x} does not answer token0() — not a Uniswap V3 pool"))?;
    let t1 = call_view(provider, pool, abi_function(abi, "token1")?, &[]).await?;
    let f = call_view(provider, pool, abi_function(abi, "fee")?, &[]).await?;
    let spacing = call_view(provider, pool, abi_function(abi, "tickSpacing")?, &[]).await?;
    let liq = call_view(provider, pool, abi_function(abi, "liquidity")?, &[]).await?;
    let slot0 = call_view(provider, pool, abi_function(abi, "slot0")?, &[]).await?;

    let token0 = as_address(out(&t0, 0, "pool.token0")?, "pool.token0")?;
    let token1 = as_address(out(&t1, 0, "pool.token1")?, "pool.token1")?;
    let fee = as_u32(out(&f, 0, "pool.fee")?, "pool.fee")?;

    let canonical = get_pool(provider, token0, token1, fee).await?;
    anyhow::ensure!(
        canonical == pool,
        "{pool:#x} is not a canonical Uniswap V3 pool on Sepolia — the factory maps \
         {token0:#x}/{token1:#x} at fee tier {fee} to {canonical:#x}"
    );

    let tick_spacing = as_i32(out(&spacing, 0, "pool.tickSpacing")?, "pool.tickSpacing")?;
    anyhow::ensure!(
        tick_spacing > 0,
        "{pool:#x} reports a non-positive tickSpacing ({tick_spacing}) — refusing to derive a \
         range against it"
    );

    Ok(V3PoolState {
        token0,
        token1,
        fee,
        tick_spacing,
        current_tick: as_i32(out(&slot0, 1, "slot0.tick")?, "slot0.tick")?,
        sqrt_price_x96: as_u256(out(&slot0, 0, "slot0.sqrtPriceX96")?, "slot0.sqrtPriceX96")?,
        liquidity: as_u256(out(&liq, 0, "pool.liquidity")?, "pool.liquidity")?,
    })
}

/// ERC-721 `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`.
const ERC721_TRANSFER_TOPIC: B256 =
    b256!("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");

/// Finds the id of the position NFT minted to `owner` in a create transaction's logs.
///
/// A mint is a Transfer from the zero address. Both the emitting contract and the recipient are
/// matched so that an unrelated ERC-721 touched by the same transaction cannot be mistaken for
/// the position — which would report a token id the agent does not own.
///
/// Takes `alloy::primitives::Log` rather than the RPC log type purely so tests can build one
/// with `Log::new_unchecked` instead of assembling block metadata.
fn parse_minted_token_id(
    logs: &[PrimitiveLog],
    position_manager: Address,
    owner: Address,
) -> Result<U256> {
    let minted = logs.iter().find(|log| {
        log.address == position_manager
            && log.topics().first() == Some(&ERC721_TRANSFER_TOPIC)
            && log.topics().get(1).is_some_and(|t| t.is_zero())
            && log
                .topics()
                .get(2)
                .is_some_and(|t| Address::from_word(*t) == owner)
            && log.topics().len() == 4
    });

    let log = minted.ok_or_else(|| {
        anyhow::anyhow!(
            "no position-NFT mint found in the create transaction's logs: expected an ERC-721 \
             Transfer from the zero address to {owner:#x} emitted by {position_manager:#x}"
        )
    })?;

    Ok(U256::from_be_bytes(log.topics()[3].0))
}

// ---------------------------------------------------------------------------
// Liquidity API client
//
// A different service from the Trading API `trading` uses, with its own base URL, but the same
// UNISWAP_API_KEY. Request bodies are built by pure functions so the wire format is pinned by
// unit tests rather than only discovered against the live API.
//
// Only the currently documented schema is implemented. If a response does not match, these
// parsers fail loudly with a bounded excerpt rather than falling back to a guess — a silent
// mis-parse here would mean signing a transaction we did not correctly understand.
// ---------------------------------------------------------------------------

fn lp_api_base() -> String {
    std::env::var("UNISWAP_LP_API_URL")
        .unwrap_or_else(|_| "https://liquidity.api.uniswap.org".to_string())
}

/// Response bodies land in error messages; cap them so a large or hostile payload can't flood
/// the tool output. The API key is only ever sent in a header, so it is never in this text.
fn excerpt(body: &str) -> String {
    const MAX: usize = 600;
    if body.chars().count() <= MAX {
        return body.to_string();
    }
    let head: String = body.chars().take(MAX).collect();
    format!("{head}… (truncated)")
}

async fn lp_post(http: &reqwest::Client, path: &str, body: &Value) -> Result<Value> {
    let api_key = std::env::var("UNISWAP_API_KEY").context("UNISWAP_API_KEY not set")?;

    let resp = http
        .post(format!("{}{path}", lp_api_base()))
        .header("x-api-key", api_key)
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .with_context(|| format!("uniswap {path} request failed"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .with_context(|| format!("reading uniswap {path} response body failed"))?;

    anyhow::ensure!(
        status.is_success(),
        "uniswap {path} returned {status}: {}",
        excerpt(&text)
    );

    serde_json::from_str(&text)
        .with_context(|| format!("uniswap {path} response is not JSON: {}", excerpt(&text)))
}

/// Everything /lp/create needs about the position being opened. Grouped, following the
/// `QuoteParams` / `SignTransactionParams` convention elsewhere in the crate, so repeated passes
/// over the same position differ only in `simulate`.
struct CreateParams<'a> {
    wallet: Address,
    pool: Address,
    pool_tokens: &'a V3PoolState,
    independent_token: Address,
    independent_amount: U256,
    tick_lower: i32,
    tick_upper: i32,
    slippage: Option<f64>,
}

/// POST /lp/create body for a position in an *existing* pool.
///
/// `simulate` is false only for the pre-approval sizing calls that exist to learn the dependent
/// token amount — the wallet may not hold the allowances yet, so server-side simulation would
/// fail for a reason that says nothing about whether the position is valid. It is true for every
/// fetch of a transaction we might actually sign, when a simulation failure is real signal.
fn build_lp_create_body(p: &CreateParams<'_>, simulate: bool) -> Value {
    let mut body = json!({
        "walletAddress": p.wallet.to_checksum(None),
        "chainId": SEPOLIA_V3.chain_id,
        "protocol": "V3",
        "existingPool": {
            "token0Address": p.pool_tokens.token0.to_checksum(None),
            "token1Address": p.pool_tokens.token1.to_checksum(None),
            "poolReference": p.pool.to_checksum(None),
        },
        "independentToken": {
            "tokenAddress": p.independent_token.to_checksum(None),
            "amount": p.independent_amount.to_string(),
        },
        "tickBounds": {
            "tickLower": p.tick_lower,
            "tickUpper": p.tick_upper,
        },
        "simulateTransaction": simulate,
    });
    if let Some(s) = p.slippage {
        body["slippageTolerance"] = json!(s);
    }
    body
}

fn build_check_approval_body(wallet: Address, lp_tokens: &[(Address, U256)]) -> Value {
    json!({
        "walletAddress": wallet.to_checksum(None),
        "chainId": SEPOLIA_V3.chain_id,
        "protocol": "V3",
        "action": "CREATE",
        "lpTokens": lp_tokens
            .iter()
            .map(|(token, amount)| json!({
                "tokenAddress": token.to_checksum(None),
                "amount": amount.to_string(),
            }))
            .collect::<Vec<_>>(),
        // Ask for permits as plain transactions so approvals go through the same
        // vault-sign-and-broadcast path as everything else, instead of needing a second
        // off-chain EIP-712 signing route.
        "generatePermitAsTransaction": true,
        "simulateTransaction": true,
    })
}

fn build_lp_decrease_body(
    wallet: Address,
    position: &V3Position,
    nft_token_id: U256,
    liquidity_percentage_to_decrease: u8,
    slippage: Option<f64>,
) -> Value {
    let mut body = json!({
        "walletAddress": wallet.to_checksum(None),
        "chainId": SEPOLIA_V3.chain_id,
        "protocol": "V3",
        "token0Address": position.token0.to_checksum(None),
        "token1Address": position.token1.to_checksum(None),
        "nftTokenId": nft_token_id.to_string(),
        "liquidityPercentageToDecrease": liquidity_percentage_to_decrease,
        // Unwrap-free withdrawal: the agent's wallet may be a contract that cannot receive raw
        // ETH, and WETH is uniformly transferable.
        "withdrawAsWeth": true,
        "simulateTransaction": true,
    });
    if let Some(s) = slippage {
        body["slippageTolerance"] = json!(s);
    }
    body
}

fn build_lp_claim_fees_body(wallet: Address, nft_token_id: U256) -> Value {
    json!({
        "protocol": "V3",
        "walletAddress": wallet.to_checksum(None),
        "chainId": SEPOLIA_V3.chain_id,
        "tokenId": nft_token_id.to_string(),
        "collectAsWeth": true,
        "simulateTransaction": true,
    })
}

/// Pulls the approval transactions out of a /lp/check_approval response.
///
/// Documented shape: `{ transactions: [{ transaction, cancelApproval, action, gasFee }] }`.
/// An empty array is the normal "already approved" case. Anything else is an error naming the
/// field, not a fallback — guessing at an undocumented shape risks signing the wrong calldata.
fn parse_approval_transactions(resp: &Value) -> Result<Vec<Value>> {
    let transactions = resp
        .get("transactions")
        .ok_or_else(|| {
            anyhow::anyhow!(
                "uniswap /lp/check_approval response has no 'transactions' field: {}",
                excerpt(&resp.to_string())
            )
        })?
        .as_array()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "uniswap /lp/check_approval 'transactions' is not an array: {}",
                excerpt(&resp.to_string())
            )
        })?;

    transactions
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            entry
                .get("transaction")
                .filter(|t| !t.is_null())
                .cloned()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "uniswap /lp/check_approval transactions[{i}] has no 'transaction': {}",
                        excerpt(&entry.to_string())
                    )
                })
        })
        .collect()
}

/// Reads a required `{ tokenAddress, amount }` pair out of an LP API response.
///
/// The amount is checked to be a plain decimal integer here rather than trusted as an opaque
/// string, because it is both fed back into /lp/check_approval (where a malformed value could
/// widen an approval) and returned to the caller as a settled figure. Zero is allowed: a range
/// entirely on one side of the current price legitimately deposits only one of the two tokens.
fn parse_lp_token(resp: &Value, field: &str, path: &str) -> Result<(Address, U256)> {
    let token = resp.get(field).ok_or_else(|| {
        anyhow::anyhow!(
            "uniswap {path} response has no '{field}': {}",
            excerpt(&resp.to_string())
        )
    })?;

    let address: Address = token
        .get("tokenAddress")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("uniswap {path} {field} has no 'tokenAddress'"))?
        .parse()
        .with_context(|| format!("uniswap {path} {field}.tokenAddress is not an address"))?;

    let raw = token
        .get("amount")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("uniswap {path} {field} has no 'amount'"))?;

    anyhow::ensure!(
        !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()),
        "uniswap {path} {field}.amount is not a decimal integer: {raw:?}"
    );

    let amount = U256::from_str_radix(raw, 10)
        .with_context(|| format!("uniswap {path} {field}.amount {raw:?} is out of range"))?;

    Ok((address, amount))
}

/// Checks that the token pair the API reported is the pair we already resolved on-chain.
///
/// Everything downstream keys off these addresses — they decide which tokens get approved for
/// spending, and they are handed back to the caller as the settled result. Taking them on trust
/// would mean an unexpected or swapped pair could route an approval at a token the agent never
/// intended to spend, so the on-chain pair (from the pool, or from the position NFT) is the
/// authority and the API response has to agree with it.
fn ensure_pair_matches(
    returned: (Address, Address),
    expected: (Address, Address),
    path: &str,
) -> Result<()> {
    anyhow::ensure!(
        returned == expected,
        "uniswap {path} returned token pair {:#x}/{:#x}, but the on-chain pair is {:#x}/{:#x} — \
         refusing to act on a mismatched pair",
        returned.0,
        returned.1,
        expected.0,
        expected.1
    );
    Ok(())
}

fn require_field<'a>(resp: &'a Value, field: &str, path: &str) -> Result<&'a Value> {
    resp.get(field).filter(|v| !v.is_null()).ok_or_else(|| {
        anyhow::anyhow!(
            "uniswap {path} response has no '{field}' transaction: {}",
            excerpt(&resp.to_string())
        )
    })
}

fn lp_token_json(token: &(Address, U256)) -> Value {
    json!({ "tokenAddress": token.0.to_checksum(None), "amount": token.1.to_string() })
}

// ---------------------------------------------------------------------------
// Transaction validation
// ---------------------------------------------------------------------------

/// A transaction from the Liquidity API that has passed every structural check.
///
/// `data` is carried through byte-for-byte. Nothing here rewrites API calldata — the checks
/// either pass it along unchanged or refuse to sign it.
#[derive(Debug)]
pub struct ValidatedTx {
    pub to: Address,
    pub data: Bytes,
    pub value: U256,
}

/// Structural checks on an API-provided transaction, run before it is simulated or signed.
///
/// The `from` and `chainId` checks are what stop a malformed or mismatched API response from
/// being signed by the agent's vault on a chain, or as an identity, the caller never asked for.
/// Empty calldata is rejected because every LP operation is a contract call — a bare value
/// transfer to the position manager would be a silent loss.
///
/// `expected_to` pins the destination. The create/decrease/claim transactions must all land on
/// the Sepolia NonfungiblePositionManager, so anything else — a different contract, a different
/// deployment, an EOA — is refused before it can be signed. It is `None` only for approvals,
/// whose destination is legitimately the ERC-20 being approved rather than a fixed address;
/// those are constrained by simulating them instead.
fn validate_api_transaction(
    tx: &Value,
    expected_from: Address,
    expected_chain_id: u64,
    expected_to: Option<Address>,
) -> Result<ValidatedTx> {
    let to: Address = tx
        .get("to")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("transaction has no 'to'"))?
        .parse()
        .context("transaction 'to' is not a valid address")?;

    if let Some(expected_to) = expected_to {
        anyhow::ensure!(
            to == expected_to,
            "transaction targets {to:#x}, but this operation must go to the Sepolia \
             NonfungiblePositionManager at {expected_to:#x} — refusing to sign"
        );
    }

    let from: Address = tx
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("transaction has no 'from'"))?
        .parse()
        .context("transaction 'from' is not a valid address")?;

    anyhow::ensure!(
        from == expected_from,
        "transaction 'from' is {from:#x} but this agent's wallet is {expected_from:#x} — \
         refusing to sign a transaction built for a different sender"
    );

    let chain_id = match tx.get("chainId") {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
    .ok_or_else(|| anyhow::anyhow!("transaction has no usable 'chainId'"))?;

    anyhow::ensure!(
        chain_id == expected_chain_id,
        "transaction targets chainId {chain_id} but this tool only operates on \
         {expected_chain_id} — refusing to sign"
    );

    let data_str = tx
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("transaction has no 'data'"))?;

    anyhow::ensure!(
        !data_str.is_empty() && data_str != "0x" && data_str != "0X",
        "transaction 'data' is empty — every liquidity operation is a contract call, so empty \
         calldata would move value without invoking anything"
    );

    let data: Bytes = data_str.parse().context("transaction 'data' is not hex")?;

    let value = match tx.get("value") {
        None | Some(Value::Null) => U256::ZERO,
        Some(Value::String(s)) => {
            parse_flexible_u256(s).context("transaction 'value' is invalid")?
        }
        Some(Value::Number(n)) => U256::from(
            n.as_u64()
                .ok_or_else(|| anyhow::anyhow!("transaction 'value' is not a valid integer"))?,
        ),
        Some(other) => anyhow::bail!("transaction 'value' is not a valid integer: {other}"),
    };

    Ok(ValidatedTx { to, data, value })
}

/// Dry-runs a validated transaction with eth_call before it is signed, so a revert costs
/// nothing. `from` is set so the simulation sees the agent's own balances and allowances.
async fn simulate_tx(provider: &impl Provider, from: Address, tx: &ValidatedTx) -> Result<()> {
    provider
        .call(
            TransactionRequest::default()
                .from(from)
                .to(tx.to)
                .value(tx.value)
                .input(tx.data.clone().into()),
        )
        .await
        .map(|_| ())
        .context("eth_call simulation reverted — not broadcasting")
}

/// The resolved context every LP tool runs in: which agent is acting, its vault-backed wallet,
/// and the Sepolia endpoint to read and broadcast through.
struct LpSession<'a> {
    agent_id: &'a str,
    db: &'a DbPool,
    wallet: Address,
    provider: DynProvider,
    rpc_url: String,
}

impl LpSession<'_> {
    /// Signs a validated transaction through the agent's vault and broadcasts it.
    async fn sign_and_broadcast(&self, tx: &ValidatedTx) -> Result<B256> {
        let signed = sign_transaction(
            self.db,
            SignTransactionParams {
                agent_id: self.agent_id.to_string(),
                chain_id: SEPOLIA_V3.chain_id,
                rpc_url: self.rpc_url.clone(),
                to: tx.to,
                value: tx.value,
                data: tx.data.clone(),
                nonce: None,
            },
        )
        .await
        .context("signing transaction failed")?;

        let pending = self
            .provider
            .send_raw_transaction(&signed)
            .await
            .context("eth_sendRawTransaction failed")?;

        Ok(*pending.tx_hash())
    }
}

// ---------------------------------------------------------------------------
// ERC-20 reads
// ---------------------------------------------------------------------------

async fn erc20_decimals(provider: &impl Provider, token: Address) -> Result<u8> {
    let outs = call_view(provider, token, abi_function(erc20_abi(), "decimals")?, &[])
        .await
        .with_context(|| format!("{token:#x} does not answer decimals() — not an ERC-20 token"))?;

    let raw = as_u256(out(&outs, 0, "decimals")?, "decimals")?;
    u8::try_from(raw).with_context(|| format!("{token:#x} reports an absurd decimals() value"))
}

async fn erc20_balance_of(
    provider: &impl Provider,
    token: Address,
    owner: Address,
) -> Result<U256> {
    let outs = call_view(
        provider,
        token,
        abi_function(erc20_abi(), "balanceOf")?,
        &[DynSolValue::Address(owner)],
    )
    .await?;

    as_u256(out(&outs, 0, "balanceOf")?, "balanceOf")
}

// ---------------------------------------------------------------------------
// Human-readable token amounts
//
// The public tools take amounts the way a person writes them ("0.01" ETH, "20" USDC) and convert
// to base units here, using the token's own on-chain decimals(). Everything downstream — sizing,
// approvals, calldata — stays in exact U256 base units. No float ever touches an amount: a
// binary float cannot represent most decimal fractions, and being off by one wei in an approval
// or a deposit is a real, if small, loss.
// ---------------------------------------------------------------------------

/// `10^exp` as a `U256`. Written out rather than reached for via a library `pow` so the overflow
/// case is explicit — an absurd `decimals()` from a hostile token must not wrap.
fn pow10(exp: u8) -> Result<U256> {
    let mut acc = U256::from(1u64);
    for _ in 0..exp {
        acc = acc
            .checked_mul(U256::from(10u64))
            .ok_or_else(|| anyhow::anyhow!("token decimals {exp} is too large to represent"))?;
    }
    Ok(acc)
}

/// Parses a human-written decimal amount into base units, exactly.
///
/// Accepts only `123` or `123.456` — no sign, no exponent, no whitespace, no thousands
/// separators, no bare/trailing dot. Those are rejected rather than coerced because every one of
/// them is ambiguous about intent, and this value ends up as a spending approval.
///
/// More fractional digits than the token has is an error, not a silent truncation: `"1.5"` of a
/// 0-decimal token is not `1`, it is a request the caller should restate.
fn parse_human_decimal_amount(raw: &str, decimals: u8) -> Result<U256> {
    anyhow::ensure!(
        !raw.is_empty(),
        "amount is empty — expected a decimal number like \"0.01\" or \"20\""
    );

    let (int_part, frac_part) = match raw.split_once('.') {
        Some((i, f)) => (i, f),
        None => (raw, ""),
    };

    anyhow::ensure!(
        !int_part.is_empty()
            && int_part.bytes().all(|b| b.is_ascii_digit())
            && frac_part.bytes().all(|b| b.is_ascii_digit())
            && !raw.ends_with('.'),
        "amount {raw:?} is not a plain decimal number — write it like \"0.01\" or \"20\" \
         (no sign, no exponent, no spaces, no thousands separators)"
    );

    anyhow::ensure!(
        frac_part.len() <= decimals as usize,
        "amount {raw:?} has {} decimal places but this token only has {decimals} — it cannot be \
         represented exactly, so restate it with at most {decimals}",
        frac_part.len()
    );

    let scale = pow10(decimals)?;
    let whole = U256::from_str_radix(int_part, 10)
        .with_context(|| format!("amount {raw:?} is too large"))?
        .checked_mul(scale)
        .ok_or_else(|| anyhow::anyhow!("amount {raw:?} is too large"))?;

    // Right-pad the fraction to the token's precision: "5" on an 18-decimal token is 5e17, not 5.
    let fraction = if frac_part.is_empty() {
        U256::ZERO
    } else {
        let padded = pow10(decimals - frac_part.len() as u8)?;
        U256::from_str_radix(frac_part, 10)
            .with_context(|| format!("amount {raw:?} is too large"))?
            * padded
    };

    let total = whole
        .checked_add(fraction)
        .ok_or_else(|| anyhow::anyhow!("amount {raw:?} is too large"))?;

    anyhow::ensure!(
        !total.is_zero(),
        "amount {raw:?} is zero — supply a positive amount"
    );

    Ok(total)
}

/// Renders base units back as a human decimal, for display only — never fed back into calldata.
fn format_human_amount(raw: U256, decimals: u8) -> String {
    if decimals == 0 {
        return raw.to_string();
    }

    let digits = raw.to_string();
    let d = decimals as usize;
    let (whole, frac) = if digits.len() > d {
        let (w, f) = digits.split_at(digits.len() - d);
        (w.to_string(), f.to_string())
    } else {
        ("0".to_string(), format!("{:0>width$}", digits, width = d))
    };

    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        whole
    } else {
        format!("{whole}.{frac}")
    }
}

// ---------------------------------------------------------------------------
// Tick range derivation
//
// A caller says "±10%" (1000 bps) and gets a valid, spacing-aligned tick range bracketing the
// current price. Ticks are a log-scale coordinate — price = 1.0001^tick — so a percentage band
// becomes a logarithm, and that is the one place in this module that uses floating point.
//
// That is deliberate and bounded: the result is a tick, immediately snapped outward onto a
// coarse tickSpacing grid (10/60/200 for the standard tiers), and valid ticks are confined to
// ±887272 — far inside f64's exactly-representable integer range. Precision loss cannot move a
// snapped boundary. Token amounts, where exactness genuinely matters, never touch a float.
// ---------------------------------------------------------------------------

/// Uniswap V3's absolute tick bounds (`TickMath.MIN_TICK`/`MAX_TICK`).
const MIN_TICK: i32 = -887272;
const MAX_TICK: i32 = 887272;

/// Largest multiple of `spacing` that is `<= tick`.
fn floor_to_spacing(tick: i32, spacing: i32) -> i32 {
    let mut snapped = (tick / spacing) * spacing;
    if tick < 0 && snapped != tick {
        snapped -= spacing; // Rust truncates toward zero, which rounds *up* for negatives.
    }
    snapped
}

/// Smallest multiple of `spacing` that is `>= tick`.
fn ceil_to_spacing(tick: i32, spacing: i32) -> i32 {
    let snapped = floor_to_spacing(tick, spacing);
    if snapped == tick {
        snapped
    } else {
        snapped + spacing
    }
}

pub struct TickRange {
    pub lower: i32,
    pub upper: i32,
}

/// Turns a symmetric percentage band around the current price into a spacing-aligned tick range.
///
/// `range_width_bps` is the movement allowed on *each* side: 1000 means roughly -10%/+10% before
/// snapping. Both bounds snap strictly outward, so the resulting range always contains the
/// current tick — a range that failed to bracket the price would silently create a one-sided
/// position holding only one of the two tokens.
fn derive_tick_range(
    current_tick: i32,
    tick_spacing: i32,
    range_width_bps: u16,
) -> Result<TickRange> {
    anyhow::ensure!(
        tick_spacing > 0,
        "pool reports a non-positive tickSpacing ({tick_spacing})"
    );
    anyhow::ensure!(
        (1..10_000).contains(&range_width_bps),
        "rangeWidthBps must be between 1 and 9999, got {range_width_bps}"
    );

    let bps = f64::from(range_width_bps);
    let ln_base = 1.0001_f64.ln();
    let lower_offset = ((1.0 - bps / 10_000.0).ln() / ln_base).floor();
    let upper_offset = ((1.0 + bps / 10_000.0).ln() / ln_base).ceil();

    // Saturating: a current tick near the domain edge plus an offset must clamp, not wrap.
    let raw_lower = i64::from(current_tick) + lower_offset as i64;
    let raw_upper = i64::from(current_tick) + upper_offset as i64;

    let usable_min = ceil_to_spacing(MIN_TICK, tick_spacing);
    let usable_max = floor_to_spacing(MAX_TICK, tick_spacing);

    let lower = floor_to_spacing(
        raw_lower.clamp(MIN_TICK.into(), MAX_TICK.into()) as i32,
        tick_spacing,
    )
    .clamp(usable_min, usable_max);
    let upper = ceil_to_spacing(
        raw_upper.clamp(MIN_TICK.into(), MAX_TICK.into()) as i32,
        tick_spacing,
    )
    .clamp(usable_min, usable_max);

    anyhow::ensure!(
        lower < upper,
        "derived tick range collapsed at the edge of the pool's usable range \
         (current tick {current_tick}, spacing {tick_spacing}, width {range_width_bps} bps)"
    );

    Ok(TickRange { lower, upper })
}

// ---------------------------------------------------------------------------
// Pool selection
// ---------------------------------------------------------------------------

/// The standard V3 fee tiers, probed in this order when the caller doesn't name a pool.
/// Nonstandard tiers exist and stay reachable by passing `poolAddress` explicitly.
const STANDARD_FEE_TIERS: [u32; 4] = [100, 500, 3000, 10000];

/// A pool that exists and has liquidity, as found while probing fee tiers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolCandidate {
    pub fee: u32,
    pub address: Address,
    pub liquidity: U256,
}

/// Probes the standard fee tiers for pools that exist and hold liquidity.
///
/// A fee tier with no pool (`getPool` returns the zero address) or a pool nobody has provided
/// liquidity to yet is skipped rather than reported — quoting against an empty pool would
/// produce a nonsense price.
async fn probe_standard_pools(
    provider: &impl Provider,
    token_a: Address,
    token_b: Address,
) -> Result<Vec<PoolCandidate>> {
    let mut found = Vec::new();

    for fee in STANDARD_FEE_TIERS {
        let address = get_pool(provider, token_a, token_b, fee).await?;
        if address.is_zero() {
            continue;
        }

        let liq = call_view(
            provider,
            address,
            abi_function(pool_abi(), "liquidity")?,
            &[],
        )
        .await?;
        let liquidity = as_u256(out(&liq, 0, "pool.liquidity")?, "pool.liquidity")?;

        found.push(PoolCandidate {
            fee,
            address,
            liquidity,
        });
    }

    Ok(found)
}

/// Picks the deepest pool, preferring the lower fee tier on an exact tie.
///
/// Deepest wins because liquidity is what determines how little the position's own deposit moves
/// the price. The tie-break is arbitrary but must be *deterministic* — the same request should
/// never open a position in a different pool on a retry — so it is fixed here and documented in
/// the tool description: lower fee tier wins, which is also the better deal for the LP's
/// counterparties and the more conventional default.
///
/// Kept separate from the probing loop so the choice is testable without a live provider.
fn choose_pool(candidates: &[PoolCandidate]) -> Option<PoolCandidate> {
    candidates
        .iter()
        .filter(|c| !c.liquidity.is_zero())
        .copied()
        .reduce(|best, c| {
            if c.liquidity > best.liquidity {
                c
            } else {
                best
            }
        })
}

// ---------------------------------------------------------------------------
// Argument parsing / validation
// ---------------------------------------------------------------------------

/// Every LP tool is Sepolia-only, and says so rather than quietly acting on another chain.
fn require_sepolia(args: &Map<String, Value>) -> Result<()> {
    let chain_id = super::common::parse_chain_id_arg(args)
        .ok_or_else(|| anyhow::anyhow!("missing or invalid 'chainId' argument"))?;

    anyhow::ensure!(
        chain_id == SEPOLIA_V3.chain_id,
        "Uniswap V3 liquidity tools support Ethereum Sepolia ({}) only — got chainId {chain_id}",
        SEPOLIA_V3.chain_id
    );
    Ok(())
}

/// Strictly decimal. Rejects "", "abc", "0x1", "-1" and anything else that is not a plain
/// base-10 integer, so a malformed id fails here rather than as an opaque eth_call revert.
fn parse_nft_token_id(args: &Map<String, Value>) -> Result<U256> {
    let raw = args
        .get("nftTokenId")
        .ok_or_else(|| anyhow::anyhow!("missing 'nftTokenId' argument"))?;

    let s = match raw {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.is_u64() => n.to_string(),
        other => anyhow::bail!(
            "'nftTokenId' must be a decimal string (the ERC-721 token id), got {other}"
        ),
    };

    anyhow::ensure!(
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
        "'nftTokenId' must be a decimal string (the ERC-721 token id), got {s:?}"
    );

    U256::from_str_radix(&s, 10).with_context(|| format!("'nftTokenId' {s:?} is out of range"))
}

fn parse_address_arg(args: &Map<String, Value>, key: &str) -> Result<Address> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing '{key}' argument"))?
        .parse()
        .with_context(|| format!("'{key}' is not a valid 0x-prefixed 20-byte address"))
}

/// Optional slippage tolerance in percent. Rejected rather than clamped if nonsensical, since
/// this is the bound on how much worse than quoted a fill may be.
fn parse_slippage_arg(args: &Map<String, Value>) -> Result<Option<f64>> {
    let Some(v) = args.get("slippageTolerance").filter(|v| !v.is_null()) else {
        return Ok(None);
    };

    let pct = v.as_f64().ok_or_else(|| {
        anyhow::anyhow!("'slippageTolerance' must be a number of percent, got {v}")
    })?;

    anyhow::ensure!(
        pct.is_finite() && pct > 0.0 && pct <= 100.0,
        "'slippageTolerance' must be a percentage greater than 0 and at most 100, got {pct}"
    );

    Ok(Some(pct))
}

/// Percentage of a position's liquidity to withdraw. 100 means close it out entirely.
fn parse_liquidity_percentage(args: &Map<String, Value>) -> Result<u8> {
    let v = args
        .get("liquidityPercentageToDecrease")
        .ok_or_else(|| anyhow::anyhow!("missing 'liquidityPercentageToDecrease' argument"))?;

    let pct = match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
    .ok_or_else(|| {
        anyhow::anyhow!("'liquidityPercentageToDecrease' must be a whole percentage, got {v}")
    })?;

    anyhow::ensure!(
        (1..=100).contains(&pct),
        "'liquidityPercentageToDecrease' must be between 1 and 100, got {pct}"
    );

    Ok(pct as u8)
}

/// Native ETH held back from wrapping so the wallet can still pay for the wrap, the approvals
/// and the mint.
///
/// A fixed, deliberately generous figure rather than a gas estimate: this is a fail-fast bound
/// that produces a clear error before anything is broadcast, not the real protection. The real
/// protection is that every transaction is `eth_call`-simulated first, which catches an actual
/// insufficient-funds condition precisely and regardless of what this constant says.
const MIN_NATIVE_GAS_RESERVE_WEI: u128 = 10_000_000_000_000_000; // 0.01 ETH

/// How many times the create flow will re-fund/re-approve and refetch before giving up.
const MAX_RECONCILIATION_ATTEMPTS: usize = 3;

/// Most positions `list_v3_positions` will enumerate in one call.
///
/// Each position costs two eth_calls plus a factory lookup, so an unbounded list would be a
/// slow request against a wallet holding hundreds. Far above what an agent wallet realistically
/// holds; when it is hit the response says so rather than silently returning a prefix.
const LIST_POSITIONS_LIMIT: usize = 50;

/// A token as named by the caller: either an ERC-20 address, or native ETH.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenArg {
    /// The address used for pools, approvals and the Liquidity API — WETH when `is_native`.
    pub address: Address,
    /// True when the caller wrote "ETH", meaning the wallet may need to wrap to fund this side.
    pub is_native: bool,
}

/// Resolves `"ETH"` or a `0x` address into the address every downstream layer should use.
///
/// A V3 pool never holds native ETH — the pair is always WETH — so `"ETH"` is a convenience for
/// the caller, normalized here once so that pool lookups, approvals and API calls all agree.
fn parse_token_arg(args: &Map<String, Value>, key: &str) -> Result<TokenArg> {
    let raw = args
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing '{key}' argument (an ERC-20 address, or \"ETH\")"))?
        .trim();

    if raw == "ETH" {
        return Ok(TokenArg {
            address: SEPOLIA_V3.weth,
            is_native: true,
        });
    }

    // Only the exact string "ETH" is native; anything else must be an address. Catching
    // near-misses explicitly beats letting "eth" fail as an unparseable address.
    anyhow::ensure!(
        !raw.eq_ignore_ascii_case("eth") && !raw.eq_ignore_ascii_case("weth"),
        "'{key}' must be either the exact string \"ETH\" (uppercase) for native ether, or a \
         0x-prefixed token address — got {raw:?}"
    );

    let address: Address = raw
        .parse()
        .with_context(|| format!("'{key}' is not a valid token address or the string \"ETH\""))?;

    Ok(TokenArg {
        address,
        is_native: false,
    })
}

/// Optional whole-number bps band, defaulting to 1000 (±10%).
fn parse_range_width_bps(args: &Map<String, Value>) -> Result<u16> {
    const DEFAULT_RANGE_WIDTH_BPS: u16 = 1000;

    let Some(v) = args.get("rangeWidthBps").filter(|v| !v.is_null()) else {
        return Ok(DEFAULT_RANGE_WIDTH_BPS);
    };

    let bps = match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
    .ok_or_else(|| {
        anyhow::anyhow!("'rangeWidthBps' must be a whole number of basis points, got {v}")
    })?;

    anyhow::ensure!(
        (1..10_000).contains(&bps),
        "'rangeWidthBps' must be between 1 and 9999 (10000 bps would put the lower bound at a \
         price of zero), got {bps}"
    );

    Ok(bps as u16)
}

/// Appends every transaction this flow has already broadcast to an error.
///
/// Wraps and approvals are real on-chain state changes. If the flow dies after some of them
/// land, the caller has to know which ones actually happened — otherwise a retry looks like it
/// is starting from scratch when it isn't, and the wallet has silently moved.
fn with_completed_txs<T>(result: Result<T>, completed: &[String]) -> Result<T> {
    match result {
        Ok(v) => Ok(v),
        Err(e) if completed.is_empty() => Err(e),
        Err(e) => Err(anyhow::anyhow!(
            "{e:#} (completed transactions: {})",
            completed.join(", ")
        )),
    }
}

// ---------------------------------------------------------------------------
// Create planning
//
// Everything between "the caller said this" and "we are about to sign something" lives here, in
// one function that *cannot* sign. `plan_create_v3_position` reads chain state and asks the
// Liquidity API to size a position; it holds no reference to a vault, a signer or a DbPool, so
// there is no path from it to sign_and_broadcast. That is what makes a read-only dry run
// trustworthy: not discipline, but the absence of the capability.
// ---------------------------------------------------------------------------

/// The caller's request, parsed but not yet resolved against the chain.
#[derive(Debug)]
struct CreateRequest {
    token_a: TokenArg,
    token_b: TokenArg,
    max_a_raw: String,
    max_b_raw: String,
    range_width_bps: u16,
    explicit_pool: Option<Address>,
    slippage: Option<f64>,
}

/// A fully-resolved, ready-to-execute position — the output of planning, the input to signing.
struct CreatePlan {
    pool_address: Address,
    pool: V3PoolState,
    selection_method: &'static str,
    range: TickRange,
    /// Base-unit ceilings after clamping the caller's request to what the wallet can actually
    /// fund. Never larger than what was requested.
    effective0: U256,
    effective1: U256,
    decimals0: u8,
    decimals1: u8,
    /// Which side is priced independently, and at what amount. Fixed once chosen: only the
    /// dependent side moves as the price does.
    independent_token: Address,
    independent_amount: U256,
    /// True when token0/token1 is the side the caller named "ETH" and may need wrapping.
    native_is_token0: bool,
    native_is_token1: bool,
    /// Balances as of planning, used to compute the first wrap.
    weth_balance: U256,
    /// The first `simulateTransaction: true` quote. Re-fetched during reconciliation.
    quote: Value,
}

impl CreatePlan {
    /// Rebuilds the /lp/create body parameters for a refetch: same pool, same range, same
    /// independent side and amount — only the price Uniswap quotes against has moved.
    fn refetch_params(&self, wallet: Address, slippage: Option<f64>) -> CreateParams<'_> {
        CreateParams {
            wallet,
            pool: self.pool_address,
            pool_tokens: &self.pool,
            independent_token: self.independent_token,
            independent_amount: self.independent_amount,
            tick_lower: self.range.lower,
            tick_upper: self.range.upper,
            slippage,
        }
    }

    fn weth_side_amount(&self, quote_amounts: (U256, U256)) -> Option<U256> {
        match (self.native_is_token0, self.native_is_token1) {
            (true, _) => Some(quote_amounts.0),
            (_, true) => Some(quote_amounts.1),
            _ => None,
        }
    }
}

fn parse_create_request(args: &Map<String, Value>) -> Result<CreateRequest> {
    let token_a = parse_token_arg(args, "tokenA")?;
    let token_b = parse_token_arg(args, "tokenB")?;

    anyhow::ensure!(
        !(token_a.is_native && token_b.is_native),
        "tokenA and tokenB are both \"ETH\" — a pool needs two different tokens"
    );
    anyhow::ensure!(
        token_a.address != token_b.address,
        "tokenA and tokenB resolve to the same token ({:#x}) — note that \"ETH\" resolves to \
         WETH, so pairing \"ETH\" with the WETH address is the same token twice",
        token_a.address
    );

    // Amounts are read as raw strings here and converted once decimals() is known.
    let max_a_raw = match args.get("maxTokenAAmount") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => anyhow::bail!(
            "'maxTokenAAmount' must be a quoted decimal string, not a number — write \"{n}\" so \
             the exact value survives JSON encoding"
        ),
        Some(other) => anyhow::bail!("'maxTokenAAmount' must be a decimal string, got {other}"),
        None => anyhow::bail!("missing 'maxTokenAAmount' argument (e.g. \"0.01\")"),
    };
    let max_b_raw = match args.get("maxTokenBAmount") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => anyhow::bail!(
            "'maxTokenBAmount' must be a quoted decimal string, not a number — write \"{n}\" so \
             the exact value survives JSON encoding"
        ),
        Some(other) => anyhow::bail!("'maxTokenBAmount' must be a decimal string, got {other}"),
        None => anyhow::bail!("missing 'maxTokenBAmount' argument (e.g. \"20\")"),
    };

    let explicit_pool = match args.get("poolAddress").filter(|v| !v.is_null()) {
        Some(_) => Some(parse_address_arg(args, "poolAddress")?),
        None => None,
    };

    Ok(CreateRequest {
        token_a,
        token_b,
        max_a_raw,
        max_b_raw,
        range_width_bps: parse_range_width_bps(args)?,
        explicit_pool,
        slippage: parse_slippage_arg(args)?,
    })
}

/// Resolves a request into an executable plan. Reads chain state and sizes against the Liquidity
/// API; signs nothing, broadcasts nothing, and has no way to.
async fn plan_create_v3_position(
    provider: &impl Provider,
    http: &reqwest::Client,
    wallet: Address,
    req: &CreateRequest,
) -> Result<CreatePlan> {
    // --- pool: either the one named, verified, or the deepest standard tier ---
    let (pool_address, pool, selection_method) = match req.explicit_pool {
        Some(addr) => {
            let state = read_v3_pool_state(provider, addr)
                .await
                .context("stage=pool read")?;
            (addr, state, "explicit")
        }
        None => {
            let candidates =
                probe_standard_pools(provider, req.token_a.address, req.token_b.address)
                    .await
                    .context("stage=pool read")?;

            let chosen = choose_pool(&candidates).ok_or_else(|| {
                anyhow::anyhow!(
                    "no Uniswap V3 pool with liquidity exists for {:#x}/{:#x} on Sepolia at any \
                     standard fee tier (100, 500, 3000, 10000) — pass poolAddress explicitly to \
                     use a nonstandard-fee pool",
                    req.token_a.address,
                    req.token_b.address
                )
            })?;

            let state = read_v3_pool_state(provider, chosen.address)
                .await
                .context("stage=pool read")?;
            (chosen.address, state, "auto:greatest-liquidity")
        }
    };

    // The pool decides the pair; the caller's two tokens must be exactly that pair.
    let requested = [req.token_a.address, req.token_b.address];
    anyhow::ensure!(
        requested.contains(&pool.token0) && requested.contains(&pool.token1),
        "pool {pool_address:#x} holds {:#x}/{:#x}, which is not the requested pair {:#x}/{:#x}",
        pool.token0,
        pool.token1,
        req.token_a.address,
        req.token_b.address
    );

    // Map the caller's A/B onto the pool's canonical token0/token1 ordering.
    let a_is_token0 = req.token_a.address == pool.token0;
    let (native_is_token0, native_is_token1) = if a_is_token0 {
        (req.token_a.is_native, req.token_b.is_native)
    } else {
        (req.token_b.is_native, req.token_a.is_native)
    };

    let decimals0 = erc20_decimals(provider, pool.token0)
        .await
        .context("stage=pool read")?;
    let decimals1 = erc20_decimals(provider, pool.token1)
        .await
        .context("stage=pool read")?;

    let (raw0, raw1) = if a_is_token0 {
        (&req.max_a_raw, &req.max_b_raw)
    } else {
        (&req.max_b_raw, &req.max_a_raw)
    };
    let requested0 = parse_human_decimal_amount(raw0, decimals0)
        .with_context(|| format!("invalid maximum amount for {:#x}", pool.token0))?;
    let requested1 = parse_human_decimal_amount(raw1, decimals1)
        .with_context(|| format!("invalid maximum amount for {:#x}", pool.token1))?;

    // --- effective budgets: what the wallet can actually fund, never more than requested ---
    let native_balance = provider
        .get_balance(wallet)
        .await
        .context("stage=balance read: eth_getBalance failed")?;
    let spendable_native = native_balance.saturating_sub(U256::from(MIN_NATIVE_GAS_RESERVE_WEI));

    let weth_balance = if native_is_token0 || native_is_token1 {
        erc20_balance_of(provider, SEPOLIA_V3.weth, wallet)
            .await
            .context("stage=balance read")?
    } else {
        U256::ZERO
    };

    let available0 = if native_is_token0 {
        weth_balance + spendable_native
    } else {
        erc20_balance_of(provider, pool.token0, wallet)
            .await
            .context("stage=balance read")?
    };
    let available1 = if native_is_token1 {
        weth_balance + spendable_native
    } else {
        erc20_balance_of(provider, pool.token1, wallet)
            .await
            .context("stage=balance read")?
    };

    let effective0 = requested0.min(available0);
    let effective1 = requested1.min(available1);

    // Fail here, before any transaction exists, rather than after wrapping or approving.
    for (effective, token, native, decimals) in [
        (effective0, pool.token0, native_is_token0, decimals0),
        (effective1, pool.token1, native_is_token1, decimals1),
    ] {
        anyhow::ensure!(
            !effective.is_zero(),
            "wallet {wallet:#x} has nothing available to deposit for {token:#x}{} — {}",
            if native {
                " (the \"ETH\" side, held as WETH)"
            } else {
                ""
            },
            if native {
                format!(
                    "it holds {} WETH and {} spendable native ETH (after reserving {} ETH for \
                     gas)",
                    format_human_amount(weth_balance, decimals),
                    format_human_amount(spendable_native, 18),
                    format_human_amount(U256::from(MIN_NATIVE_GAS_RESERVE_WEI), 18)
                )
            } else {
                format!(
                    "its balance is {}",
                    format_human_amount(available0.min(available1), decimals)
                )
            }
        );
    }

    // --- range ---
    let range = derive_tick_range(pool.current_tick, pool.tick_spacing, req.range_width_bps)?;

    // --- sizing: try token0 as the independent side, fall back to token1 ---
    let mut params = CreateParams {
        wallet,
        pool: pool_address,
        pool_tokens: &pool,
        independent_token: pool.token0,
        independent_amount: effective0,
        tick_lower: range.lower,
        tick_upper: range.upper,
        slippage: req.slippage,
    };

    let sizing0 = lp_post(http, "/lp/create", &build_lp_create_body(&params, false))
        .await
        .context("stage=API request")?;
    let (_sized0, got1) = quote_amounts(&sizing0, &pool)?;

    let (independent_token, independent_amount) = if got1 <= effective1 {
        (pool.token0, effective0)
    } else {
        params.independent_token = pool.token1;
        params.independent_amount = effective1;

        let sizing1 = lp_post(http, "/lp/create", &build_lp_create_body(&params, false))
            .await
            .context("stage=API request")?;
        let (alt0, _alt1) = quote_amounts(&sizing1, &pool)?;

        anyhow::ensure!(
            alt0 <= effective0,
            "this range cannot be funded within both maximums: sizing from {:#x} needs {} of \
             {:#x} (limit {}), and sizing from {:#x} needs {} of {:#x} (limit {}). Narrow \
             rangeWidthBps or raise a maximum.",
            pool.token0,
            format_human_amount(got1, decimals1),
            pool.token1,
            format_human_amount(effective1, decimals1),
            pool.token1,
            format_human_amount(alt0, decimals0),
            pool.token0,
            format_human_amount(effective0, decimals0),
        );

        (pool.token1, effective1)
    };

    params.independent_token = independent_token;
    params.independent_amount = independent_amount;

    // The first quote we might actually sign, so simulation is meaningful now.
    let quote = lp_post(http, "/lp/create", &build_lp_create_body(&params, true))
        .await
        .context("stage=API request")?;
    let (q0, q1) = quote_amounts(&quote, &pool)?;
    ensure_within_budgets(q0, q1, effective0, effective1, decimals0, decimals1, &pool)?;

    Ok(CreatePlan {
        pool_address,
        pool,
        selection_method,
        range,
        effective0,
        effective1,
        decimals0,
        decimals1,
        independent_token,
        independent_amount,
        native_is_token0,
        native_is_token1,
        weth_balance,
        quote,
    })
}

/// Reads a /lp/create response's two amounts, confirming the pair is the pool's own.
fn quote_amounts(resp: &Value, pool: &V3PoolState) -> Result<(U256, U256)> {
    let t0 = parse_lp_token(resp, "token0", "/lp/create").context("stage=API request")?;
    let t1 = parse_lp_token(resp, "token1", "/lp/create").context("stage=API request")?;
    ensure_pair_matches((t0.0, t1.0), (pool.token0, pool.token1), "/lp/create")
        .context("stage=API request")?;
    Ok((t0.1, t1.1))
}

/// The caller's ceilings are a hard limit at every point a quote is re-read, not just the first.
#[allow(clippy::too_many_arguments)]
fn ensure_within_budgets(
    amount0: U256,
    amount1: U256,
    effective0: U256,
    effective1: U256,
    decimals0: u8,
    decimals1: u8,
    pool: &V3PoolState,
) -> Result<()> {
    for (amount, effective, token, decimals) in [
        (amount0, effective0, pool.token0, decimals0),
        (amount1, effective1, pool.token1, decimals1),
    ] {
        anyhow::ensure!(
            amount <= effective,
            "Uniswap now wants {} of {token:#x} but the usable maximum is {} — refusing to \
             deposit more than requested",
            format_human_amount(amount, decimals),
            format_human_amount(effective, decimals)
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

fn sepolia_chain_id_prop() -> Value {
    json!({
        "type": "string",
        "enum": [SEPOLIA_V3.chain_id.to_string()],
        "description": format!(
            "EVM chain ID as a string. Uniswap V3 liquidity tools support Ethereum Sepolia \
             ({}) only; any other value is rejected.",
            SEPOLIA_V3.chain_id
        ),
    })
}

fn nft_token_id_prop() -> Value {
    json!({
        "type": "string",
        "description": "The position NFT's ERC-721 token id, as a decimal string. Must be owned \
                        by the authenticated agent's own wallet."
    })
}

fn object_schema(props: Vec<(&str, Value)>, required: &[&str]) -> Map<String, Value> {
    let mut properties = Map::new();
    for (k, v) in props {
        properties.insert(k.to_string(), v);
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(properties));
    schema.insert(
        "required".to_string(),
        Value::Array(
            required
                .iter()
                .map(|s| Value::String(s.to_string()))
                .collect(),
        ),
    );
    schema
}

fn slippage_prop() -> Value {
    json!({
        "type": "number",
        "description": "Maximum acceptable slippage in percent (e.g. 0.5 for 0.5%). Optional — \
                        Uniswap applies its own default if omitted."
    })
}

pub(super) fn build_uniswap_lp_tools() -> Vec<Tool> {
    let get_v3_position = Tool::new(
        "get_v3_position".to_string(),
        "Read a Uniswap V3 liquidity position owned by the authenticated agent on Ethereum \
         Sepolia. Returns the pool, token pair, fee tier, tick range, liquidity, and the \
         position's tokensOwed0/tokensOwed1. IMPORTANT: tokensOwed0/1 are NOT the position's \
         current claimable fees. They are a cached balance written the last time the position \
         was touched on-chain (mint, increase, decrease or collect), and do not include any fees \
         accrued since — for an untouched position they are usually stale, and often zero even \
         when real fees are owed. Computing live claimable fees requires reading pool and tick \
         fee-growth accumulators, which this tool does not do. Read-only: pure on-chain reads, \
         no Uniswap API call, no signing, no funds moved. Fails if the position NFT is not owned \
         by the agent's own wallet."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                ("nftTokenId", nft_token_id_prop()),
            ],
            &["chainId", "nftTokenId"],
        ),
    );

    let create_v3_position = Tool::new(
        "create_v3_position".to_string(),
        "Open a new Uniswap V3 liquidity position on Ethereum Sepolia, on behalf of the \
         authenticated agent. Fund-moving and fully automatic: give it a token pair and how much \
         of each you are willing to spend, and it picks the pool, derives a price range around \
         the current price, sizes the position to fit both budgets, wraps ETH if needed, runs \
         approvals, then simulates, signs and broadcasts the mint through the agent's vault. You \
         never supply ticks, wei amounts, a wallet address, a private key or an rpc_url. \
         Amounts are human-readable decimal strings in whole tokens ('0.01' ETH, '20' USDC) — \
         NOT wei; the token's on-chain decimals are read and applied for you. Either token may be \
         the string 'ETH' for native ether, which is wrapped to WETH automatically and only by \
         the shortfall not already held. Both amounts are ceilings, not targets: the position is \
         sized to the largest that fits inside both, and is further capped by what the wallet \
         actually holds, so it can spend less than you allow but never more. Opens positions in \
         EXISTING pools only — it cannot create a pool."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                (
                    "tokenA",
                    json!({
                        "type": "string",
                        "description": "First token of the pair: an ERC-20 address, or the exact \
                                        string \"ETH\" for native ether (which is used as WETH). \
                                        Order does not matter — the pool's own token0/token1 ordering \
                                        is used internally."
                    }),
                ),
                (
                    "tokenB",
                    json!({
                        "type": "string",
                        "description": "Second token of the pair. Same format as tokenA. At most one \
                                        of the two may be \"ETH\"."
                    }),
                ),
                (
                    "maxTokenAAmount",
                    json!({
                        "type": "string",
                        "description": "Most of tokenA to deposit, as a human-readable decimal string \
                                        in whole tokens (e.g. \"0.01\" for 0.01 ETH, \"20\" for 20 \
                                        USDC). NOT wei. Must be quoted, positive, and no more precise \
                                        than the token's decimals. This is a ceiling: the actual \
                                        deposit may be smaller."
                    }),
                ),
                (
                    "maxTokenBAmount",
                    json!({
                        "type": "string",
                        "description": "Most of tokenB to deposit, same format as maxTokenAAmount."
                    }),
                ),
                (
                    "rangeWidthBps",
                    json!({
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9999,
                        "description": "Half-width of the position's price range, in basis points of \
                                        price movement on EACH side of the current price. 1000 (the \
                                        default) is about -10%/+10%. Smaller concentrates liquidity \
                                        for more fees but goes out of range sooner. The exact ticks \
                                        are derived from the pool's live price and snapped outward to \
                                        its tick spacing, always bracketing the current price."
                    }),
                ),
                (
                    "poolAddress",
                    json!({
                        "type": "string",
                        "description": "Optional. A specific Uniswap V3 pool to use, verified against \
                                        the V3 factory and required to hold exactly the requested \
                                        pair. Omit it to search the standard fee tiers (100, 500, \
                                        3000, 10000) and use the one with the most liquidity, \
                                        preferring the lower fee tier on an exact tie. Supply it to \
                                        reach a pool with a nonstandard fee tier."
                    }),
                ),
                ("slippageTolerance", slippage_prop()),
            ],
            &[
                "chainId",
                "tokenA",
                "tokenB",
                "maxTokenAAmount",
                "maxTokenBAmount",
            ],
        ),
    );

    let decrease_v3_position = Tool::new(
        "decrease_v3_position".to_string(),
        "Withdraw liquidity from a Uniswap V3 position owned by the authenticated agent on \
         Ethereum Sepolia. Fund-moving: simulates, signs and broadcasts automatically through \
         the agent's vault. Pass liquidityPercentageToDecrease=100 to close the position out \
         entirely. NOTE: on Uniswap V3 this also collects the position's accrued fees — the \
         transaction is a multicall of decreaseLiquidity followed by collect() with no cap, so \
         it sweeps the freed principal AND every fee owed. You do not need to call claim_v3_fees \
         first, and calling it afterwards will typically find nothing left. Be careful with the \
         returned token0/token1 amounts: Uniswap reports the principal being withdrawn, NOT the \
         fees swept alongside it, so the wallet can receive materially more than these figures \
         (an amount here may even read 0 while that token is in fact collected as fees). Any ETH \
         side is withdrawn as WETH. Does not open a replacement position."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                ("nftTokenId", nft_token_id_prop()),
                (
                    "liquidityPercentageToDecrease",
                    json!({
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "Whole percentage of the position's liquidity to \
                                        withdraw, 1-100. Use 100 to withdraw all of it."
                    }),
                ),
                ("slippageTolerance", slippage_prop()),
            ],
            &["chainId", "nftTokenId", "liquidityPercentageToDecrease"],
        ),
    );

    let claim_v3_fees = Tool::new(
        "claim_v3_fees".to_string(),
        "Collect the trading fees accrued by a Uniswap V3 position owned by the authenticated \
         agent on Ethereum Sepolia, without touching its liquidity. Fund-moving: simulates, \
         signs and broadcasts automatically through the agent's vault. Any ETH side is collected \
         as WETH. Use this to take fees while leaving the position open; it is not a prerequisite \
         for decrease_v3_position, which already collects fees as part of withdrawing."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                ("nftTokenId", nft_token_id_prop()),
            ],
            &["chainId", "nftTokenId"],
        ),
    );

    let get_v3_pool_state = Tool::new(
        "get_v3_pool_state".to_string(),
        "Read the live state of a Uniswap V3 pool on Ethereum Sepolia: token pair, fee tier, \
         current tick and sqrt price, tick spacing, and active in-range liquidity. Read-only: \
         pure on-chain reads, no Uniswap API call, no wallet involved, no funds moved. The \
         address is verified against the canonical V3 factory, so a contract that merely mimics \
         a pool's interface is rejected. Use this to inspect price and depth before opening a \
         position — create_v3_position derives its own range internally, so you do not need this \
         to compute ticks."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                (
                    "poolAddress",
                    json!({
                        "type": "string",
                        "description": "Address of a Uniswap V3 pool on Sepolia. Verified against \
                                        the V3 factory before anything is returned."
                    }),
                ),
            ],
            &["chainId", "poolAddress"],
        ),
    );

    let list_v3_positions = Tool::new(
        "list_v3_positions".to_string(),
        format!(
            "List the Uniswap V3 liquidity positions the authenticated agent's own wallet holds \
             on Ethereum Sepolia. Read-only: pure on-chain reads, no Uniswap API call, no \
             signing, no funds moved. The wallet is resolved from the agent's vault — you do not \
             pass an address, and positions owned by anyone else are never returned. Each entry \
             carries the same fields as get_v3_position, including the tokensOwed0/1 caveat: \
             those are a cached balance from the position's last on-chain touch, not its live \
             claimable fees. At most {LIST_POSITIONS_LIMIT} positions are returned; if the wallet \
             holds more, `truncated` is true and `totalOwned` reports the real count."
        ),
        object_schema(vec![("chainId", sepolia_chain_id_prop())], &["chainId"]),
    );

    vec![
        get_v3_position,
        get_v3_pool_state,
        list_v3_positions,
        create_v3_position,
        decrease_v3_position,
        claim_v3_fees,
    ]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

impl UniswapMcpServer {
    /// A Sepolia RPC provider and the url behind it, with no vault involved.
    ///
    /// Read-only tools use this instead of `lp_session`: the HTTP route already requires a valid
    /// bearer token for every call, and a pool-state read has no ownership concept, so demanding
    /// the calling agent also have a vault *provisioned* would only produce a confusing
    /// vault-resolution error from a tool that never touches a vault.
    async fn sepolia_rpc(&self, tool: &str) -> Result<(String, DynProvider)> {
        let db = self
            .db
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("{tool} requires a database connection"))?;

        let rpc_url = db
            .get_network(SEPOLIA_V3.chain_id)
            .await
            .context("looking up network config failed")?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no network registered for chainId {} — the registry needs a Sepolia \
                     rpc_url in its `networks` table before liquidity tools can be used",
                    SEPOLIA_V3.chain_id
                )
            })?
            .rpc_url;

        let provider = ProviderBuilder::new()
            .connect(&rpc_url)
            .await
            .context("rpc connect failed")?;

        Ok((rpc_url, provider.erased()))
    }

    /// Everything a fund-moving LP tool needs before it can do anything: who is acting, where to
    /// sign, and what to talk to. None of it is a tool argument — the wallet comes from the
    /// agent's vault and the rpc_url from the `networks` table.
    async fn lp_session(&self, tool: &str) -> Result<LpSession<'_>> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("{tool} requires an authenticated agent"))?;
        let db = self
            .db
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("{tool} requires a database connection"))?;

        let wallet = resolve_agent_address(db, agent_id)
            .await
            .context("resolving agent wallet failed")?;

        let (rpc_url, provider) = self.sepolia_rpc(tool).await?;

        Ok(LpSession {
            agent_id,
            db,
            wallet,
            provider,
            rpc_url,
        })
    }

    pub(super) async fn handle_list_v3_positions(
        &self,
        args: &Map<String, Value>,
    ) -> Result<String> {
        require_sepolia(args)?;

        let s = self.lp_session("list_v3_positions").await?;

        let balance_out = call_view(
            &s.provider,
            SEPOLIA_V3.position_manager,
            abi_function(position_manager_abi(), "balanceOf")?,
            &[DynSolValue::Address(s.wallet)],
        )
        .await
        .context("stage=position read")?;
        let balance = as_u256(out(&balance_out, 0, "balanceOf")?, "balanceOf")
            .context("stage=position read")?;

        let total = usize::try_from(balance).unwrap_or(usize::MAX);
        let shown = total.min(LIST_POSITIONS_LIMIT);

        let mut positions = Vec::with_capacity(shown);
        for index in 0..shown {
            let id_out = call_view(
                &s.provider,
                SEPOLIA_V3.position_manager,
                abi_function(position_manager_abi(), "tokenOfOwnerByIndex")?,
                &[
                    DynSolValue::Address(s.wallet),
                    DynSolValue::Uint(U256::from(index), 256),
                ],
            )
            .await
            .context("stage=position read")?;
            let token_id = as_u256(
                out(&id_out, 0, "tokenOfOwnerByIndex")?,
                "tokenOfOwnerByIndex",
            )
            .context("stage=position read")?;

            // Deliberately re-confirms ownership per item rather than trusting that enumeration
            // implies it: one code path that always checks beats a second that assumes.
            let pos = read_v3_position(&s.provider, token_id, s.wallet)
                .await
                .context("stage=position read")?;

            positions.push(json!({
                "nftTokenId": token_id.to_string(),
                "poolAddress": pos.pool.to_checksum(None),
                "token0": pos.token0.to_checksum(None),
                "token1": pos.token1.to_checksum(None),
                "fee": pos.fee.to_string(),
                "tickLower": pos.tick_lower.to_string(),
                "tickUpper": pos.tick_upper.to_string(),
                "liquidity": pos.liquidity.to_string(),
                "tokensOwed0": pos.tokens_owed0.to_string(),
                "tokensOwed1": pos.tokens_owed1.to_string(),
            }));
        }

        Ok(json!({
            "chainId": SEPOLIA_V3.chain_id,
            "walletAddress": s.wallet.to_checksum(None),
            "count": positions.len(),
            "totalOwned": total,
            "truncated": total > shown,
            "positions": positions,
        })
        .to_string())
    }

    pub(super) async fn handle_get_v3_pool_state(
        &self,
        args: &Map<String, Value>,
    ) -> Result<String> {
        require_sepolia(args)?;
        let pool_address = parse_address_arg(args, "poolAddress")?;

        let (_rpc_url, provider) = self.sepolia_rpc("get_v3_pool_state").await?;

        let pool = read_v3_pool_state(&provider, pool_address)
            .await
            .context("stage=pool read")?;

        Ok(json!({
            "chainId": SEPOLIA_V3.chain_id,
            "poolAddress": pool_address.to_checksum(None),
            "token0": pool.token0.to_checksum(None),
            "token1": pool.token1.to_checksum(None),
            "fee": pool.fee.to_string(),
            "currentTick": pool.current_tick.to_string(),
            "sqrtPriceX96": pool.sqrt_price_x96.to_string(),
            "tickSpacing": pool.tick_spacing.to_string(),
            "liquidity": pool.liquidity.to_string(),
        })
        .to_string())
    }

    pub(super) async fn handle_get_v3_position(&self, args: &Map<String, Value>) -> Result<String> {
        require_sepolia(args)?;
        let nft_token_id = parse_nft_token_id(args)?;

        let s = self.lp_session("get_v3_position").await?;

        let pos = read_v3_position(&s.provider, nft_token_id, s.wallet)
            .await
            .context("stage=position read")?;

        Ok(json!({
            "chainId": SEPOLIA_V3.chain_id,
            "walletAddress": s.wallet.to_checksum(None),
            "nftTokenId": nft_token_id.to_string(),
            "poolAddress": pos.pool.to_checksum(None),
            "token0": pos.token0.to_checksum(None),
            "token1": pos.token1.to_checksum(None),
            "fee": pos.fee.to_string(),
            "tickLower": pos.tick_lower.to_string(),
            "tickUpper": pos.tick_upper.to_string(),
            "liquidity": pos.liquidity.to_string(),
            "tokensOwed0": pos.tokens_owed0.to_string(),
            "tokensOwed1": pos.tokens_owed1.to_string(),
        })
        .to_string())
    }

    /// Opens a position in an existing V3 pool.
    ///
    /// Planning (pool choice, range, budgets, sizing) happens in `plan_create_v3_position`,
    /// which cannot sign. Everything from here on can, so it is deliberately linear and every
    /// transaction that lands is recorded before the next one is attempted.
    ///
    /// The loop exists because a quote goes stale while its own approvals confirm: by the time a
    /// wrap and two approvals are mined, Uniswap may want a slightly different amount, which can
    /// need *more* WETH or *more* allowance than we just provided. Signing the old quote would
    /// revert; signing the new one unfunded would too. So each pass re-reads what the current
    /// quote needs, provides exactly that, refetches, and only signs once a quote needs nothing
    /// further. Bounded, because a pool volatile enough not to settle in three passes is one
    /// this tool should decline rather than chase.
    pub(super) async fn handle_create_v3_position(
        &self,
        args: &Map<String, Value>,
    ) -> Result<String> {
        require_sepolia(args)?;
        let req = parse_create_request(args)?;

        let s = self.lp_session("create_v3_position").await?;

        let mut plan = plan_create_v3_position(&s.provider, &self.http, s.wallet, &req).await?;

        // Every hash below is on-chain and irreversible; each is recorded the moment it is
        // broadcast so that any later failure can report it.
        let mut completed: Vec<String> = Vec::new();
        let mut wrap_hashes: Vec<String> = Vec::new();
        let mut approval_hashes: Vec<String> = Vec::new();
        let mut total_wrapped = U256::ZERO;
        let mut attempts = 0usize;

        loop {
            attempts += 1;
            let (want0, want1) = quote_amounts(&plan.quote, &plan.pool)?;

            // What this quote still needs that the wallet does not already have.
            let needed_wrap = match plan.weth_side_amount((want0, want1)) {
                Some(needed) => needed.saturating_sub(plan.weth_balance + total_wrapped),
                None => U256::ZERO,
            };

            let approvals = with_completed_txs(
                lp_post(
                    &self.http,
                    "/lp/check_approval",
                    &build_check_approval_body(
                        s.wallet,
                        &[(plan.pool.token0, want0), (plan.pool.token1, want1)],
                    ),
                )
                .await
                .context("stage=API request")
                .and_then(|r| parse_approval_transactions(&r).context("stage=API request")),
                &completed,
            )?;

            if needed_wrap.is_zero() && approvals.is_empty() {
                break;
            }

            anyhow::ensure!(
                attempts <= MAX_RECONCILIATION_ATTEMPTS,
                "{}",
                with_completed_txs::<()>(
                    Err(anyhow::anyhow!(
                        "the quote did not settle after {MAX_RECONCILIATION_ATTEMPTS} rounds of \
                         funding and approval — the pool's price is moving faster than \
                         transactions confirm; try again or widen rangeWidthBps"
                    )),
                    &completed,
                )
                .unwrap_err()
            );

            if !needed_wrap.is_zero() {
                let hash = with_completed_txs(
                    s.wrap_native_to_weth(needed_wrap)
                        .await
                        .context("stage=wrap"),
                    &completed,
                )?;
                let hash = format!("{hash:#x}");
                completed.push(hash.clone());
                wrap_hashes.push(hash);
                total_wrapped += needed_wrap;
            }

            for (i, approval) in approvals.iter().enumerate() {
                let step = format!("approval {}/{}", i + 1, approvals.len());

                // No destination pin: an approval's `to` is legitimately the ERC-20 being
                // approved, which varies per pool.
                let validated = with_completed_txs(
                    validate_api_transaction(approval, s.wallet, SEPOLIA_V3.chain_id, None)
                        .with_context(|| format!("stage=approval ({step})")),
                    &completed,
                )?;

                with_completed_txs(
                    simulate_tx(&s.provider, s.wallet, &validated)
                        .await
                        .with_context(|| format!("stage=simulation ({step})")),
                    &completed,
                )?;

                let hash = with_completed_txs(
                    s.sign_and_broadcast(&validated)
                        .await
                        .with_context(|| format!("stage=broadcast ({step})")),
                    &completed,
                )?;
                completed.push(format!("{hash:#x}"));
                approval_hashes.push(format!("{hash:#x}"));

                with_completed_txs(
                    wait_for_receipt(&s.provider, hash, &step)
                        .await
                        .with_context(|| format!("stage=receipt ({step})")),
                    &completed,
                )?;
            }

            // Those transactions took real block time; the quote we just funded may already be
            // stale, so re-price before deciding anything.
            plan.quote = with_completed_txs(
                lp_post(
                    &self.http,
                    "/lp/create",
                    &build_lp_create_body(&plan.refetch_params(s.wallet, req.slippage), true),
                )
                .await
                .context("stage=API request"),
                &completed,
            )?;

            let (fresh0, fresh1) =
                with_completed_txs(quote_amounts(&plan.quote, &plan.pool), &completed)?;
            with_completed_txs(
                ensure_within_budgets(
                    fresh0,
                    fresh1,
                    plan.effective0,
                    plan.effective1,
                    plan.decimals0,
                    plan.decimals1,
                    &plan.pool,
                ),
                &completed,
            )?;
        }

        // --- the quote is settled; last checks before it becomes irreversible ---
        let (final0, final1) = quote_amounts(&plan.quote, &plan.pool)?;

        with_completed_txs(
            ensure_within_budgets(
                final0,
                final1,
                plan.effective0,
                plan.effective1,
                plan.decimals0,
                plan.decimals1,
                &plan.pool,
            ),
            &completed,
        )?;

        // Re-read both balances rather than trusting our own bookkeeping: something else may
        // have moved this wallet's funds while the approvals were confirming.
        for (token, amount, decimals) in [
            (plan.pool.token0, final0, plan.decimals0),
            (plan.pool.token1, final1, plan.decimals1),
        ] {
            let held = with_completed_txs(
                erc20_balance_of(&s.provider, token, s.wallet)
                    .await
                    .context("stage=balance read"),
                &completed,
            )?;
            with_completed_txs(
                if held >= amount {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!(
                        "stage=balance read: wallet holds {} of {token:#x} but the mint needs \
                         {} — balance changed while the position was being prepared",
                        format_human_amount(held, decimals),
                        format_human_amount(amount, decimals)
                    ))
                },
                &completed,
            )?;
        }

        let create_tx = with_completed_txs(
            require_field(&plan.quote, "create", "/lp/create").context("stage=API request"),
            &completed,
        )?;

        let validated = with_completed_txs(
            validate_api_transaction(
                create_tx,
                s.wallet,
                SEPOLIA_V3.chain_id,
                Some(SEPOLIA_V3.position_manager),
            )
            .context("stage=simulation"),
            &completed,
        )?;

        with_completed_txs(
            simulate_tx(&s.provider, s.wallet, &validated)
                .await
                .context("stage=simulation"),
            &completed,
        )?;

        let hash = with_completed_txs(
            s.sign_and_broadcast(&validated)
                .await
                .context("stage=broadcast"),
            &completed,
        )?;
        completed.push(format!("{hash:#x}"));

        let receipt = with_completed_txs(
            wait_for_receipt(&s.provider, hash, "position create")
                .await
                .context("stage=receipt"),
            &completed,
        )?;

        let logs: Vec<PrimitiveLog> = receipt
            .inner
            .logs()
            .iter()
            .map(|log| log.inner.clone())
            .collect();

        let nft_token_id = with_completed_txs(
            parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, s.wallet)
                .context("stage=receipt"),
            &completed,
        )?;

        Ok(json!({
            "hash": format!("{hash:#x}"),
            "nftTokenId": nft_token_id.to_string(),
            "wrapHash": wrap_hashes.last().cloned().map(Value::String).unwrap_or(Value::Null),
            "wrapHashes": wrap_hashes,
            "approvalHashes": approval_hashes,
            "reconciliationAttempts": attempts,
            "poolAddress": plan.pool_address.to_checksum(None),
            "poolSelectionMethod": plan.selection_method,
            "fee": plan.pool.fee.to_string(),
            "currentTick": plan.pool.current_tick.to_string(),
            "tickSpacing": plan.pool.tick_spacing.to_string(),
            "tickLower": plan.range.lower.to_string(),
            "tickUpper": plan.range.upper.to_string(),
            "rangeWidthBps": req.range_width_bps,
            "adjustedMinPrice": plan.quote.get("adjustedMinPrice").cloned().unwrap_or(Value::Null),
            "adjustedMaxPrice": plan.quote.get("adjustedMaxPrice").cloned().unwrap_or(Value::Null),
            "token0": {
                "tokenAddress": plan.pool.token0.to_checksum(None),
                "amount": final0.to_string(),
                "humanAmount": format_human_amount(final0, plan.decimals0),
            },
            "token1": {
                "tokenAddress": plan.pool.token1.to_checksum(None),
                "amount": final1.to_string(),
                "humanAmount": format_human_amount(final1, plan.decimals1),
            },
            "wethFundedFromNativeEth": !wrap_hashes.is_empty(),
        })
        .to_string())
    }

    pub(super) async fn handle_decrease_v3_position(
        &self,
        args: &Map<String, Value>,
    ) -> Result<String> {
        require_sepolia(args)?;
        let nft_token_id = parse_nft_token_id(args)?;
        let percentage = parse_liquidity_percentage(args)?;
        let slippage = parse_slippage_arg(args)?;

        let s = self.lp_session("decrease_v3_position").await?;

        // Ownership check and the token pair both come from the NFT itself, so neither is
        // caller-supplied.
        let position = read_v3_position(&s.provider, nft_token_id, s.wallet)
            .await
            .context("stage=position read")?;

        let resp = lp_post(
            &self.http,
            "/lp/decrease",
            &build_lp_decrease_body(s.wallet, &position, nft_token_id, percentage, slippage),
        )
        .await
        .context("stage=API request")?;

        let token0 =
            parse_lp_token(&resp, "token0", "/lp/decrease").context("stage=API request")?;
        let token1 =
            parse_lp_token(&resp, "token1", "/lp/decrease").context("stage=API request")?;
        // The pair must be the one the position NFT actually holds. These amounts are reported
        // back as what was withdrawn, so a mismatched pair would misstate where funds went.
        ensure_pair_matches(
            (token0.0, token1.0),
            (position.token0, position.token1),
            "/lp/decrease",
        )
        .context("stage=API request")?;

        let tx = require_field(&resp, "decrease", "/lp/decrease").context("stage=API request")?;

        let hash = s.execute(tx, "decrease").await?;

        Ok(json!({
            "hash": format!("{hash:#x}"),
            "nftTokenId": nft_token_id.to_string(),
            "liquidityPercentageToDecrease": percentage,
            "token0": lp_token_json(&token0),
            "token1": lp_token_json(&token1),
        })
        .to_string())
    }

    pub(super) async fn handle_claim_v3_fees(&self, args: &Map<String, Value>) -> Result<String> {
        require_sepolia(args)?;
        let nft_token_id = parse_nft_token_id(args)?;

        let s = self.lp_session("claim_v3_fees").await?;

        // Checks ownership, and gives us the pair the reported fee amounts must belong to.
        let position = read_v3_position(&s.provider, nft_token_id, s.wallet)
            .await
            .context("stage=position read")?;

        let resp = lp_post(
            &self.http,
            "/lp/claim_fees",
            &build_lp_claim_fees_body(s.wallet, nft_token_id),
        )
        .await
        .context("stage=API request")?;

        let token0 =
            parse_lp_token(&resp, "token0", "/lp/claim_fees").context("stage=API request")?;
        let token1 =
            parse_lp_token(&resp, "token1", "/lp/claim_fees").context("stage=API request")?;
        // The fee amounts are returned to the caller as the tokens they collected, so the pair
        // has to be the position's own.
        ensure_pair_matches(
            (token0.0, token1.0),
            (position.token0, position.token1),
            "/lp/claim_fees",
        )
        .context("stage=API request")?;

        let tx = require_field(&resp, "claim", "/lp/claim_fees").context("stage=API request")?;

        let hash = s.execute(tx, "fee claim").await?;

        Ok(json!({
            "hash": format!("{hash:#x}"),
            "nftTokenId": nft_token_id.to_string(),
            "token0": lp_token_json(&token0),
            "token1": lp_token_json(&token1),
        })
        .to_string())
    }
}

impl LpSession<'_> {
    /// Wraps `amount` of native ETH into WETH and waits for it to confirm.
    ///
    /// The transaction is built here rather than taken from any API response: the destination is
    /// the compiled-in canonical WETH address and the calldata is `deposit()`'s bare selector,
    /// so there is nothing for a malformed or hostile response to influence. It still goes
    /// through the same simulate → sign → broadcast → confirm path as everything else.
    async fn wrap_native_to_weth(&self, amount: U256) -> Result<B256> {
        let calldata = abi_function(weth_abi(), "deposit")?
            .abi_encode_input(&[])
            .context("failed to encode WETH deposit() calldata")?;

        let tx = ValidatedTx {
            to: SEPOLIA_V3.weth,
            data: calldata.into(),
            value: amount,
        };

        simulate_tx(&self.provider, self.wallet, &tx)
            .await
            .context("wrapping ETH to WETH would revert")?;

        let hash = self.sign_and_broadcast(&tx).await?;
        wait_for_receipt(&self.provider, hash, "WETH wrap").await?;
        Ok(hash)
    }

    /// validate → simulate → sign → broadcast → confirm, for the single-transaction LP flows.
    ///
    /// `create_v3_position` runs these steps inline instead, because it has to thread already
    /// completed approval hashes into every possible failure.
    async fn execute(&self, tx: &Value, label: &str) -> Result<B256> {
        let validated = validate_api_transaction(
            tx,
            self.wallet,
            SEPOLIA_V3.chain_id,
            Some(SEPOLIA_V3.position_manager),
        )
        .context("stage=simulation")?;

        simulate_tx(&self.provider, self.wallet, &validated)
            .await
            .context("stage=simulation")?;

        let hash = self
            .sign_and_broadcast(&validated)
            .await
            .context("stage=broadcast")?;

        wait_for_receipt(&self.provider, hash, label)
            .await
            .context("stage=receipt")?;

        Ok(hash)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    // ─── chain validation ────────────────────────────────────────────────────

    #[test]
    fn accepts_sepolia_as_string_or_number() {
        require_sepolia(&args(&[("chainId", json!("11155111"))])).unwrap();
        require_sepolia(&args(&[("chainId", json!(11155111))])).unwrap();
    }

    #[test]
    fn rejects_every_chain_but_sepolia() {
        for chain in [
            json!("1"),
            json!(1),
            json!("8453"),
            json!("17000"),
            json!(137),
        ] {
            let err = require_sepolia(&args(&[("chainId", chain.clone())]))
                .expect_err("expected chainId {chain} to be rejected")
                .to_string();
            assert!(
                err.contains("Sepolia") && err.contains("11155111"),
                "error for {chain} should name the only supported chain, got: {err}"
            );
        }
    }

    #[test]
    fn rejects_missing_or_unparseable_chain_id() {
        assert!(require_sepolia(&args(&[])).is_err());
        assert!(require_sepolia(&args(&[("chainId", json!("sepolia"))])).is_err());
        assert!(require_sepolia(&args(&[("chainId", json!(null))])).is_err());
    }

    // ─── nftTokenId validation ───────────────────────────────────────────────

    #[test]
    fn parses_well_formed_token_ids() {
        let cases = [
            (json!("1"), 1u64),
            (json!("100000"), 100000),
            (json!(42), 42),
        ];
        for (input, expected) in cases {
            let got = parse_nft_token_id(&args(&[("nftTokenId", input.clone())]))
                .unwrap_or_else(|e| panic!("{input} should parse: {e}"));
            assert_eq!(got, U256::from(expected));
        }
    }

    #[test]
    fn rejects_malformed_token_ids() {
        // "0x1" is the interesting one: U256::from_str_radix would happily read "1" out of some
        // hex spellings, so the digit check has to run first or a hex id silently means
        // something else on-chain.
        let bad = [
            json!(""),
            json!("abc"),
            json!("0x1"),
            json!("-1"),
            json!("1.5"),
            json!(" 1"),
            json!("1 "),
            json!("1e3"),
            json!(-1),
            json!(1.5),
            json!(true),
            json!(null),
        ];
        for input in bad {
            assert!(
                parse_nft_token_id(&args(&[("nftTokenId", input.clone())])).is_err(),
                "{input} should have been rejected as an nftTokenId"
            );
        }
        assert!(
            parse_nft_token_id(&args(&[])).is_err(),
            "missing id should be rejected"
        );
    }

    // ─── positions() decoding ────────────────────────────────────────────────

    /// Real `positions(1)` return blob from the Sepolia NonfungiblePositionManager
    /// (0x1238536071E1c677A632429e3655c799b22cDA52), captured 2026-07-25. Using live data
    /// rather than a hand-built blob means this test also pins the ABI fragment itself: a
    /// wrong type width or a reordered output would decode to different values here.
    const POSITIONS_1_RETURN: &str = "0x\
000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f9840a85d5af5bf1d1762f925bdaddc4201f984000000000000000000000000fff9976782d46cc05630d1f6ebab18b2324d6b140000000000000000000000000000000000000000000000000000000000000bb8ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff103cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7dec000000000000000000000000000000000000000000000012f1c0e914b83f4a2800000000000000000000000000000000095fa90ca24ae8d7856af4c61434618800000000000000000000000000000000002bdb475f007f8e72b6a6a1a0273f6c000000000000000000000000000000000000000000000000ad356f996bcaa57f000000000000000000000000000000000000000000000000032a640d9566f49d";

    fn decode_fixture(raw: &str) -> Result<V3Position> {
        let bytes = alloy::hex::decode(raw.trim_start_matches("0x")).unwrap();
        let func = abi_function(position_manager_abi(), "positions").unwrap();
        let outs = func.abi_decode_output(&bytes)?;
        decode_positions(&outs)
    }

    #[test]
    fn decodes_a_real_positions_return() {
        let p = decode_fixture(POSITIONS_1_RETURN).expect("fixture should decode");

        assert_eq!(
            p.token0,
            address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
            "token0 should be UNI"
        );
        assert_eq!(
            p.token1,
            address!("fff9976782d46cc05630d1f6ebab18b2324d6b14"),
            "token1 should be Sepolia WETH"
        );
        assert_eq!(p.fee, 3000);
        assert_eq!(p.liquidity, U256::from(349461572960640780840u128));
        assert_eq!(p.tokens_owed0, U256::from(12481004647056319871u128));
        assert_eq!(p.tokens_owed1, U256::from(228104740639536285u128));
        // pool is only resolved by read_v3_position, which needs an RPC.
        assert_eq!(p.pool, Address::ZERO);
    }

    #[test]
    fn decodes_negative_ticks_as_signed() {
        // Both ticks in the fixture are negative int24s. Reading them as unsigned would yield
        // ~16.7 million instead, which is outside V3's valid tick range and would sail past a
        // naive range check — so the sign handling is worth pinning explicitly.
        let p = decode_fixture(POSITIONS_1_RETURN).unwrap();
        assert_eq!(p.tick_lower, -61380);
        assert_eq!(p.tick_upper, -33300);
        assert!(p.tick_lower < p.tick_upper);
    }

    #[test]
    fn rejects_a_truncated_positions_return() {
        let truncated = &POSITIONS_1_RETURN[..POSITIONS_1_RETURN.len() - 64];
        assert!(
            decode_fixture(truncated).is_err(),
            "a short return blob must not decode into a partially-populated position"
        );
    }

    // ─── built-in ABIs ───────────────────────────────────────────────────────

    #[test]
    fn built_in_abis_parse_and_expose_the_functions_we_call() {
        for name in ["ownerOf", "positions", "balanceOf", "tokenOfOwnerByIndex"] {
            abi_function(position_manager_abi(), name).unwrap();
        }
        abi_function(factory_abi(), "getPool").unwrap();
        for name in [
            "token0",
            "token1",
            "fee",
            "tickSpacing",
            "liquidity",
            "slot0",
        ] {
            abi_function(pool_abi(), name).unwrap();
        }
    }

    /// slot0() returns seven values and we read two of them by index, so the ordering in the
    /// fragment is load-bearing exactly like positions()' is. Decoding a real return blob pins
    /// it: sqrtPriceX96 first, tick second.
    #[test]
    fn decodes_a_real_slot0_return() {
        // Live capture from the Sepolia UNI/WETH 0.3% pool
        // (0x287B0e934ed0439E2a7b1d5F0FC25eA2c24b64f7), 2026-07-25.
        const SLOT0_RETURN: &str = "0x\
0000000000000000000000000000000000000004b197a8b0d920715a9316b5f5\
00000000000000000000000000000000000000000000000000000000000078ce\
00000000000000000000000000000000000000000000000000000000000003de\
00000000000000000000000000000000000000000000000000000000000003e8\
00000000000000000000000000000000000000000000000000000000000003e8\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001";

        let bytes = alloy::hex::decode(SLOT0_RETURN.trim_start_matches("0x")).unwrap();
        let func = abi_function(pool_abi(), "slot0").unwrap();
        let outs = func
            .abi_decode_output(&bytes)
            .expect("slot0 fixture should decode");

        // Swapping these two indices is the realistic mistake, and it would be silent: a
        // sqrt price read as a tick is off by 25 orders of magnitude, not off by a little.
        let tick = as_i32(out(&outs, 1, "slot0.tick").unwrap(), "slot0.tick").unwrap();
        assert_eq!(tick, 30926, "tick is the SECOND return value");

        let sqrt = as_u256(
            out(&outs, 0, "slot0.sqrtPriceX96").unwrap(),
            "slot0.sqrtPriceX96",
        )
        .unwrap();
        assert_eq!(
            sqrt,
            U256::from(371874841214038945356433503733u128),
            "sqrtPriceX96 is the FIRST return value"
        );
    }

    #[test]
    fn sepolia_deployment_matches_the_verified_addresses() {
        assert_eq!(SEPOLIA_V3.chain_id, 11155111);
        assert_eq!(
            SEPOLIA_V3.factory,
            address!("0227628f3F023bb0B980b67D528571c95c6DaC1c")
        );
        // Guards against reintroducing 0x3B5E...697C, which is a library, not the position
        // manager: ownerOf/positions revert on it, so every LP tool would fail at read time.
        assert_eq!(
            SEPOLIA_V3.position_manager,
            address!("1238536071E1c677A632429e3655c799b22cDA52")
        );
    }

    // ─── create_v3_position argument validation ──────────────────────────────

    #[test]
    fn validates_slippage_tolerance_range() {
        assert_eq!(parse_slippage_arg(&args(&[])).unwrap(), None);
        assert_eq!(
            parse_slippage_arg(&args(&[("slippageTolerance", json!(0.5))])).unwrap(),
            Some(0.5)
        );
        for bad in [json!(0), json!(-1), json!(100.1), json!("0.5")] {
            assert!(
                parse_slippage_arg(&args(&[("slippageTolerance", bad.clone())])).is_err(),
                "{bad} should be rejected as a slippage tolerance"
            );
        }
    }

    // ─── transaction validation ──────────────────────────────────────────────

    const WALLET: Address = address!("79ea449c3375ed1a9d7d99f8068209ea748c6d42");
    const OTHER: Address = address!("37fa291fe3053c4dd58985a6cec6c448c2c47e0c");

    fn valid_tx() -> Value {
        json!({
            "to": "0x1238536071E1c677A632429e3655c799b22cDA52",
            "from": "0x79ea449c3375ed1a9d7d99f8068209ea748c6d42",
            "chainId": 11155111,
            "data": "0x88316456deadbeef",
            "value": "0",
        })
    }

    #[test]
    fn accepts_a_well_formed_transaction_without_touching_calldata() {
        let v = validate_api_transaction(&valid_tx(), WALLET, SEPOLIA_V3.chain_id, None).unwrap();
        assert_eq!(v.to, SEPOLIA_V3.position_manager);
        assert_eq!(v.value, U256::ZERO);
        assert_eq!(
            alloy::hex::encode_prefixed(&v.data),
            "0x88316456deadbeef",
            "calldata must survive validation byte-for-byte"
        );
    }

    #[test]
    fn rejects_a_transaction_built_for_another_sender() {
        let err = validate_api_transaction(&valid_tx(), OTHER, SEPOLIA_V3.chain_id, None)
            .expect_err("a from-mismatch must not be signed")
            .to_string();
        assert!(
            err.contains("from"),
            "error should name the mismatch: {err}"
        );
    }

    #[test]
    fn rejects_a_transaction_for_another_chain() {
        // Both spellings: the API documents chainId as a number, but a string would otherwise
        // slip through the number-only match arm as "no usable chainId" rather than a mismatch.
        for wrong in [json!(1), json!("1"), json!(8453)] {
            let mut tx = valid_tx();
            tx["chainId"] = wrong.clone();
            assert!(
                validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None).is_err(),
                "chainId {wrong} should be rejected"
            );
        }
        // ...and the matching string spelling is accepted.
        let mut tx = valid_tx();
        tx["chainId"] = json!("11155111");
        assert!(validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None).is_ok());
    }

    #[test]
    fn rejects_empty_calldata() {
        for empty in [json!(""), json!("0x"), json!("0X")] {
            let mut tx = valid_tx();
            tx["data"] = empty.clone();
            let err = validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None)
                .expect_err("empty calldata must not be signed")
                .to_string();
            assert!(err.contains("data"), "error should name 'data': {err}");
        }

        let mut tx = valid_tx();
        tx.as_object_mut().unwrap().remove("data");
        assert!(validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None).is_err());
    }

    #[test]
    fn rejects_missing_or_malformed_to_and_from() {
        for field in ["to", "from"] {
            let mut missing = valid_tx();
            missing.as_object_mut().unwrap().remove(field);
            assert!(validate_api_transaction(&missing, WALLET, SEPOLIA_V3.chain_id, None).is_err());

            let mut garbage = valid_tx();
            garbage[field] = json!("not-an-address");
            assert!(validate_api_transaction(&garbage, WALLET, SEPOLIA_V3.chain_id, None).is_err());
        }
    }

    #[test]
    fn parses_value_in_every_documented_spelling() {
        let cases = [
            (json!("0"), U256::ZERO),
            (
                json!("1000000000000000000"),
                U256::from(1_000_000_000_000_000_000u64),
            ),
            (
                json!("0x0de0b6b3a7640000"),
                U256::from(1_000_000_000_000_000_000u64),
            ),
            (json!(12345), U256::from(12345)),
        ];
        for (input, expected) in cases {
            let mut tx = valid_tx();
            tx["value"] = input.clone();
            let v = validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None)
                .unwrap_or_else(|e| panic!("value {input} should parse: {e}"));
            assert_eq!(v.value, expected);
        }

        // Absent value means zero — a create in a pool with no native side sends no ETH.
        let mut tx = valid_tx();
        tx.as_object_mut().unwrap().remove("value");
        assert_eq!(
            validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None)
                .unwrap()
                .value,
            U256::ZERO
        );

        let mut bad = valid_tx();
        bad["value"] = json!("not a number");
        assert!(validate_api_transaction(&bad, WALLET, SEPOLIA_V3.chain_id, None).is_err());
    }

    // ─── audit: destination pinning ──────────────────────────────────────────

    #[test]
    fn pins_write_transactions_to_the_position_manager() {
        // valid_tx() is already addressed to the position manager.
        assert!(
            validate_api_transaction(
                &valid_tx(),
                WALLET,
                SEPOLIA_V3.chain_id,
                Some(SEPOLIA_V3.position_manager)
            )
            .is_ok()
        );
    }

    #[test]
    fn rejects_a_write_transaction_aimed_anywhere_else() {
        // Every one of these is a plausible-looking destination that must still be refused:
        // the factory, a pool, an ERC-20, the discredited library address, and an EOA.
        let wrong_destinations = [
            SEPOLIA_V3.factory,
            address!("287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7"),
            address!("fff9976782d46cc05630d1f6ebab18b2324d6b14"),
            address!("3B5E3c5E595D85fbFBC2a42ECC091e183E76697C"),
            WALLET,
            Address::ZERO,
        ];

        for to in wrong_destinations {
            let mut tx = valid_tx();
            tx["to"] = json!(to.to_checksum(None));

            let err = validate_api_transaction(
                &tx,
                WALLET,
                SEPOLIA_V3.chain_id,
                Some(SEPOLIA_V3.position_manager),
            )
            .expect_err("only the position manager may receive a create/decrease/claim")
            .to_string();

            assert!(
                err.contains("NonfungiblePositionManager"),
                "error should say where it had to go, got: {err}"
            );
        }
    }

    #[test]
    fn approvals_are_not_destination_pinned() {
        // An approval's destination is the ERC-20 being approved, which varies per pool, so the
        // pin cannot apply to it. Approvals are constrained by simulation instead.
        let mut tx = valid_tx();
        tx["to"] = json!("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14");
        assert!(validate_api_transaction(&tx, WALLET, SEPOLIA_V3.chain_id, None).is_ok());
    }

    // ─── audit: token pair and amount validation ─────────────────────────────

    const POOL_T0: Address = address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984");
    const POOL_T1: Address = address!("fff9976782d46cc05630d1f6ebab18b2324d6b14");

    #[test]
    fn accepts_a_pair_matching_the_on_chain_pair() {
        assert!(ensure_pair_matches((POOL_T0, POOL_T1), (POOL_T0, POOL_T1), "/lp/create").is_ok());
    }

    #[test]
    fn rejects_a_substituted_token_in_the_returned_pair() {
        // The realistic hazard: a response naming a token the position/pool does not hold. These
        // addresses drive the approvals, so accepting one would authorise spending the wrong
        // asset.
        let attacker = address!("00000000000000000000000000000000deadbeef");
        for returned in [
            (attacker, POOL_T1),
            (POOL_T0, attacker),
            (attacker, attacker),
        ] {
            let err = ensure_pair_matches(returned, (POOL_T0, POOL_T1), "/lp/create")
                .expect_err("a mismatched pair must not be used")
                .to_string();
            assert!(
                err.contains("on-chain pair"),
                "error should contrast with the on-chain pair, got: {err}"
            );
        }
    }

    #[test]
    fn rejects_a_swapped_pair_ordering() {
        // token0/token1 ordering is consensus in V3 (sorted by address), so a flipped pair is a
        // real mismatch, not a cosmetic one — it would mis-attribute both amounts.
        assert!(ensure_pair_matches((POOL_T1, POOL_T0), (POOL_T0, POOL_T1), "/lp/create").is_err());
    }

    #[test]
    fn rejects_non_decimal_api_amounts() {
        // These amounts are fed into approval requests and returned as settled figures, so a
        // hex or signed spelling must not be carried through as an opaque string.
        for bad in [
            json!("0x10"),
            json!(""),
            json!("-1"),
            json!("1.5"),
            json!("1e18"),
            json!(100),
        ] {
            let resp = json!({"token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "amount": bad}});
            assert!(
                parse_lp_token(&resp, "token0", "/lp/create").is_err(),
                "amount {bad} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_a_zero_api_amount() {
        // A range entirely on one side of the current price legitimately deposits only one of
        // the two tokens, so zero must not be treated as an error.
        let resp = json!({"token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "amount": "0"}});
        assert_eq!(
            parse_lp_token(&resp, "token0", "/lp/create").unwrap().1,
            U256::ZERO
        );
    }

    // ─── human decimal amounts ───────────────────────────────────────────────

    #[test]
    fn parses_human_amounts_for_18_decimal_tokens() {
        let cases = [
            ("1", "1000000000000000000"),
            ("0.01", "10000000000000000"),
            ("0.000000000000000001", "1"),
            ("1.5", "1500000000000000000"),
            ("123.456", "123456000000000000000"),
            ("0000.5", "500000000000000000"),
        ];
        for (input, expected) in cases {
            let got = parse_human_decimal_amount(input, 18)
                .unwrap_or_else(|e| panic!("{input} should parse: {e:#}"));
            assert_eq!(got.to_string(), expected, "for input {input}");
        }
    }

    #[test]
    fn parses_human_amounts_for_6_decimal_tokens() {
        // USDC is the motivating case: "20" must become 20_000000, not 20e18.
        let cases = [
            ("20", "20000000"),
            ("0.000001", "1"),
            ("1.5", "1500000"),
            ("1234.567891", "1234567891"),
        ];
        for (input, expected) in cases {
            let got = parse_human_decimal_amount(input, 6)
                .unwrap_or_else(|e| panic!("{input} should parse: {e:#}"));
            assert_eq!(got.to_string(), expected, "for input {input}");
        }
    }

    #[test]
    fn rejects_amounts_with_more_precision_than_the_token_has() {
        // Truncating silently would deposit less than asked; rounding would deposit more.
        // Neither is ours to choose, so this is an error.
        let err = parse_human_decimal_amount("1.0000001", 6)
            .expect_err("7 decimals on a 6-decimal token must be rejected")
            .to_string();
        assert!(err.contains("decimal places"), "got: {err}");

        assert!(parse_human_decimal_amount("0.5", 0).is_err());
        // The boundary itself is fine.
        assert!(parse_human_decimal_amount("1.000001", 6).is_ok());
    }

    #[test]
    fn rejects_malformed_human_amounts() {
        let bad = [
            "",      // nothing
            "-1",    // sign
            "+1",    // sign
            "1e18",  // exponent
            "1E18",  // exponent
            "0x10",  // hex
            " 1",    // whitespace
            "1 ",    // whitespace
            "1.",    // trailing dot
            ".5",    // leading dot
            "1.2.3", // two dots
            "1,000", // thousands separator
            "abc",   // not a number
            "1_000", // rust-style separator
            "١٢٣",   // non-ascii digits
        ];
        for input in bad {
            assert!(
                parse_human_decimal_amount(input, 18).is_err(),
                "{input:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_zero_however_it_is_spelled() {
        for input in ["0", "0.0", "00", "0.000", "0000.0000"] {
            let err = parse_human_decimal_amount(input, 18)
                .expect_err("{input} is zero and should be rejected")
                .to_string();
            assert!(err.contains("zero"), "for {input}, got: {err}");
        }
    }

    #[test]
    fn formats_base_units_back_to_human_readable() {
        let cases = [
            (U256::from(1000000000000000000u64), 18, "1"),
            (U256::from(10000000000000000u64), 18, "0.01"),
            (U256::from(1u64), 18, "0.000000000000000001"),
            (U256::from(1500000000000000000u64), 18, "1.5"),
            (U256::from(20000000u64), 6, "20"),
            (U256::from(1u64), 6, "0.000001"),
            (U256::ZERO, 18, "0"),
            (U256::from(42u64), 0, "42"),
        ];
        for (raw, decimals, expected) in cases {
            assert_eq!(format_human_amount(raw, decimals), expected);
        }
    }

    #[test]
    fn human_amount_round_trips() {
        // Parse then format must return exactly what was written, for anything already in
        // canonical form — otherwise the amount reported back would not match the amount asked
        // for.
        for (text, decimals) in [
            ("0.01", 18u8),
            ("20", 6),
            ("1.5", 18),
            ("1234.567891", 6),
            ("0.000000000000000001", 18),
            ("1", 18),
        ] {
            let raw = parse_human_decimal_amount(text, decimals).unwrap();
            assert_eq!(
                format_human_amount(raw, decimals),
                text,
                "round trip for {text}"
            );
        }
    }

    // ─── token arguments ─────────────────────────────────────────────────────

    #[test]
    fn normalizes_eth_to_weth() {
        let t = parse_token_arg(&args(&[("tokenA", json!("ETH"))]), "tokenA").unwrap();
        assert_eq!(
            t.address, SEPOLIA_V3.weth,
            "ETH must resolve to canonical WETH"
        );
        assert!(t.is_native, "the wrapping path keys off this flag");
    }

    #[test]
    fn accepts_a_plain_erc20_address_as_non_native() {
        let usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
        let t = parse_token_arg(&args(&[("tokenA", json!(usdc))]), "tokenA").unwrap();
        assert_eq!(
            t.address,
            address!("1c7d4b196cb0c7b01d743fbc6116a902379c7238")
        );
        assert!(!t.is_native);
    }

    #[test]
    fn passing_the_weth_address_directly_is_not_native() {
        // Meaningful difference: this caller has WETH and does not want ETH wrapped on their
        // behalf, so no wrap should ever be attempted for this side.
        let t = parse_token_arg(
            &args(&[(
                "tokenA",
                json!("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"),
            )]),
            "tokenA",
        )
        .unwrap();
        assert_eq!(t.address, SEPOLIA_V3.weth);
        assert!(
            !t.is_native,
            "an explicit WETH address must not trigger wrapping"
        );
    }

    #[test]
    fn rejects_near_misses_for_the_eth_sentinel() {
        // "eth"/"weth" are almost certainly meant as the sentinel; failing them as unparseable
        // addresses would be a confusing way to say so.
        for bad in ["eth", "Eth", "weth", "WETH", "ether", "0xETH", ""] {
            assert!(
                parse_token_arg(&args(&[("tokenA", json!(bad))]), "tokenA").is_err(),
                "{bad:?} should be rejected"
            );
        }
        assert!(parse_token_arg(&args(&[]), "tokenA").is_err());
    }

    #[test]
    fn rejects_a_pair_that_is_the_same_token_twice() {
        let weth = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
        let usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

        // Both sides native.
        assert!(
            parse_create_request(&args(&[
                ("tokenA", json!("ETH")),
                ("tokenB", json!("ETH")),
                ("maxTokenAAmount", json!("1")),
                ("maxTokenBAmount", json!("1")),
            ]))
            .is_err()
        );

        // "ETH" plus the WETH address is the same token after normalization — the subtle case.
        let err = parse_create_request(&args(&[
            ("tokenA", json!("ETH")),
            ("tokenB", json!(weth)),
            ("maxTokenAAmount", json!("1")),
            ("maxTokenBAmount", json!("1")),
        ]))
        .expect_err("ETH and WETH are the same token")
        .to_string();
        assert!(err.contains("same token"), "got: {err}");

        // Identical addresses.
        assert!(
            parse_create_request(&args(&[
                ("tokenA", json!(usdc)),
                ("tokenB", json!(usdc)),
                ("maxTokenAAmount", json!("1")),
                ("maxTokenBAmount", json!("1")),
            ]))
            .is_err()
        );
    }

    #[test]
    fn requires_amounts_to_be_quoted_strings() {
        // A JSON number has already been through a float by the time it reaches us.
        let err = parse_create_request(&args(&[
            ("tokenA", json!("ETH")),
            (
                "tokenB",
                json!("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
            ),
            ("maxTokenAAmount", json!(0.01)),
            ("maxTokenBAmount", json!("20")),
        ]))
        .expect_err("a bare number must be refused")
        .to_string();
        assert!(err.contains("quoted decimal string"), "got: {err}");
    }

    // ─── rangeWidthBps ───────────────────────────────────────────────────────

    #[test]
    fn range_width_defaults_to_ten_percent_each_side() {
        assert_eq!(parse_range_width_bps(&args(&[])).unwrap(), 1000);
        assert_eq!(
            parse_range_width_bps(&args(&[("rangeWidthBps", json!(null))])).unwrap(),
            1000
        );
    }

    #[test]
    fn validates_the_range_width_bounds() {
        assert_eq!(
            parse_range_width_bps(&args(&[("rangeWidthBps", json!(1))])).unwrap(),
            1
        );
        assert_eq!(
            parse_range_width_bps(&args(&[("rangeWidthBps", json!(9999))])).unwrap(),
            9999
        );
        assert_eq!(
            parse_range_width_bps(&args(&[("rangeWidthBps", json!("2500"))])).unwrap(),
            2500
        );

        // 0 is a zero-width range; 10000 would put the lower bound at a price of zero.
        for bad in [json!(0), json!(10000), json!(-1), json!(1.5), json!("wide")] {
            assert!(
                parse_range_width_bps(&args(&[("rangeWidthBps", bad.clone())])).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    // ─── tick snapping and range derivation ──────────────────────────────────

    #[test]
    fn snaps_ticks_outward_including_negatives() {
        // Rust truncates toward zero, so negatives are where a naive `/ * ` gets this wrong.
        assert_eq!(floor_to_spacing(125, 60), 120);
        assert_eq!(ceil_to_spacing(125, 60), 180);
        assert_eq!(floor_to_spacing(-125, 60), -180);
        assert_eq!(ceil_to_spacing(-125, 60), -120);

        // Exact multiples must not move.
        assert_eq!(floor_to_spacing(120, 60), 120);
        assert_eq!(ceil_to_spacing(120, 60), 120);
        assert_eq!(floor_to_spacing(-120, 60), -120);
        assert_eq!(ceil_to_spacing(-120, 60), -120);

        // Spacing of 1 (the 0.01% tier) is the identity.
        assert_eq!(floor_to_spacing(-7, 1), -7);
        assert_eq!(ceil_to_spacing(-7, 1), -7);
    }

    #[test]
    fn derived_range_brackets_the_current_tick() {
        // The property that matters: a range that misses the current price silently creates a
        // one-sided position holding only one of the two tokens.
        for current in [0, 1, -1, 30926, -61380, 887000, -887000, 199, -199] {
            for spacing in [1, 10, 60, 200] {
                for bps in [1u16, 50, 1000, 5000, 9999] {
                    let r = derive_tick_range(current, spacing, bps)
                        .unwrap_or_else(|e| panic!("({current},{spacing},{bps}): {e:#}"));

                    assert!(
                        r.lower <= current && current <= r.upper,
                        "({current},{spacing},{bps}) produced [{}, {}] which does not bracket \
                         the current tick",
                        r.lower,
                        r.upper
                    );
                    assert!(r.lower < r.upper, "({current},{spacing},{bps}) collapsed");
                    assert_eq!(r.lower % spacing, 0, "lower not aligned to spacing");
                    assert_eq!(r.upper % spacing, 0, "upper not aligned to spacing");
                    assert!(
                        r.lower >= MIN_TICK && r.upper <= MAX_TICK,
                        "outside V3 bounds"
                    );
                }
            }
        }
    }

    #[test]
    fn wider_bps_produces_a_wider_or_equal_range() {
        let narrow = derive_tick_range(30926, 60, 100).unwrap();
        let wide = derive_tick_range(30926, 60, 5000).unwrap();
        assert!(wide.lower <= narrow.lower && wide.upper >= narrow.upper);
        assert!(
            (wide.upper - wide.lower) > (narrow.upper - narrow.lower),
            "5000bps should be strictly wider than 100bps at spacing 60"
        );
    }

    #[test]
    fn derived_range_is_approximately_the_requested_band() {
        // 1000 bps is ±10%. ln(1.1)/ln(1.0001) = 953.15 and ln(0.9)/ln(1.0001) = -1053.66;
        // both round outward, so the band is a shade wider than asked rather than narrower.
        // Spacing 1 keeps the snap from obscuring the arithmetic.
        let r = derive_tick_range(0, 1, 1000).unwrap();
        assert_eq!(r.upper, 954, "+10% is 953.15 ticks, ceiled outward");
        assert_eq!(r.lower, -1054, "-10% is -1053.66 ticks, floored outward");

        // The band is asymmetric in tick space because price is exponential in ticks: a 10%
        // fall is a longer log-distance than a 10% rise.
        assert!(r.upper.abs() < r.lower.abs());
    }

    #[test]
    fn range_derivation_clamps_at_the_v3_boundaries() {
        // Near the top of the tick domain the upper bound must clamp to a usable multiple
        // rather than overflow or exceed MAX_TICK.
        let r = derive_tick_range(MAX_TICK - 10, 60, 9999).unwrap();
        assert!(r.upper <= MAX_TICK);
        assert_eq!(r.upper % 60, 0);
        assert!(r.lower < r.upper);

        let r = derive_tick_range(MIN_TICK + 10, 60, 9999).unwrap();
        assert!(r.lower >= MIN_TICK);
        assert_eq!(r.lower % 60, 0);
        assert!(r.lower < r.upper);
    }

    #[test]
    fn range_derivation_rejects_bad_inputs() {
        assert!(derive_tick_range(0, 0, 1000).is_err(), "zero spacing");
        assert!(derive_tick_range(0, -60, 1000).is_err(), "negative spacing");
        assert!(derive_tick_range(0, 60, 0).is_err(), "zero width");
        assert!(derive_tick_range(0, 60, 10000).is_err(), "full width");
    }

    // ─── pool selection ──────────────────────────────────────────────────────

    fn candidate(fee: u32, liquidity: u128) -> PoolCandidate {
        PoolCandidate {
            fee,
            address: Address::from_word(B256::from(U256::from(fee).to_be_bytes::<32>())),
            liquidity: U256::from(liquidity),
        }
    }

    #[test]
    fn picks_the_deepest_pool() {
        let chosen = choose_pool(&[
            candidate(100, 5),
            candidate(500, 900),
            candidate(3000, 42),
            candidate(10000, 1),
        ])
        .expect("one should win");
        assert_eq!(chosen.fee, 500);
    }

    #[test]
    fn prefers_the_lower_fee_tier_on_an_exact_tie() {
        // Documented tie-break. It must be deterministic above all: the same request must not
        // open a position in a different pool on a retry.
        let candidates = [candidate(500, 1000), candidate(3000, 1000)];
        assert_eq!(choose_pool(&candidates).unwrap().fee, 500);
        // Order of discovery must not change the answer.
        let reversed = [candidate(3000, 1000), candidate(500, 1000)];
        assert_eq!(choose_pool(&reversed).unwrap().fee, 3000);
    }

    #[test]
    fn ignores_pools_with_no_liquidity() {
        // A pool that exists but nobody has funded would quote a nonsense price.
        let chosen = choose_pool(&[candidate(100, 0), candidate(500, 0), candidate(3000, 7)])
            .expect("the only funded pool should win");
        assert_eq!(chosen.fee, 3000);
    }

    #[test]
    fn reports_no_pool_when_none_have_liquidity() {
        assert!(choose_pool(&[]).is_none(), "no candidates at all");
        assert!(
            choose_pool(&[candidate(100, 0), candidate(3000, 0)]).is_none(),
            "existing but empty pools are not usable"
        );
    }

    #[test]
    fn standard_fee_tiers_are_probed_low_to_high() {
        // Ascending order is what makes the tie-break "lower fee wins" hold.
        assert_eq!(STANDARD_FEE_TIERS, [100, 500, 3000, 10000]);
    }

    // ─── budget enforcement ──────────────────────────────────────────────────

    #[test]
    fn accepts_a_quote_inside_both_budgets() {
        let pool = test_pool();
        assert!(
            ensure_within_budgets(
                U256::from(100u64),
                U256::from(200u64),
                U256::from(100u64),
                U256::from(200u64),
                18,
                6,
                &pool,
            )
            .is_ok(),
            "exactly at the limit is within it"
        );
    }

    #[test]
    fn rejects_a_quote_over_either_budget() {
        let pool = test_pool();

        let err = ensure_within_budgets(
            U256::from(101u64),
            U256::from(200u64),
            U256::from(100u64),
            U256::from(200u64),
            18,
            6,
            &pool,
        )
        .expect_err("token0 over budget")
        .to_string();
        assert!(err.contains("refusing to deposit more"), "got: {err}");

        assert!(
            ensure_within_budgets(
                U256::from(100u64),
                U256::from(201u64),
                U256::from(100u64),
                U256::from(200u64),
                18,
                6,
                &pool,
            )
            .is_err(),
            "token1 over budget"
        );
    }

    // ─── position enumeration ────────────────────────────────────────────────

    /// Mirrors the handler's `total`/`shown`/`truncated` arithmetic. Kept in step with it by
    /// the assertions below; the handler's own version needs a live position manager.
    fn enumeration_window(total: usize) -> (usize, bool) {
        let shown = total.min(LIST_POSITIONS_LIMIT);
        (shown, total > shown)
    }

    #[test]
    fn enumerates_every_position_below_the_limit() {
        for total in [0usize, 1, 3, 49, LIST_POSITIONS_LIMIT] {
            let (shown, truncated) = enumeration_window(total);
            assert_eq!(shown, total, "should list all {total}");
            assert!(!truncated, "{total} is within the limit");
        }
    }

    #[test]
    fn flags_truncation_past_the_limit() {
        // Silently returning a prefix would let an agent conclude a position does not exist.
        for total in [LIST_POSITIONS_LIMIT + 1, 100, 10_000] {
            let (shown, truncated) = enumeration_window(total);
            assert_eq!(shown, LIST_POSITIONS_LIMIT, "capped at the limit");
            assert!(truncated, "{total} exceeds the limit and must say so");
        }
    }

    #[test]
    fn the_enumeration_limit_is_documented_in_the_tool_description() {
        let d = description_of("list_v3_positions");
        assert!(
            d.contains(&LIST_POSITIONS_LIMIT.to_string()),
            "the cap must be stated, not discovered: {d}"
        );
        assert!(d.contains("truncated"), "the flag must be named: {d}");
        // The staleness caveat has to travel with the fields it applies to.
        assert!(d.contains("tokensOwed0/1"), "got: {d}");
        assert!(d.contains("cached"), "got: {d}");
    }

    #[test]
    fn list_positions_takes_no_wallet_argument() {
        // Accepting one would let a caller enumerate somebody else's positions.
        let tools = build_uniswap_lp_tools();
        let list = tools
            .iter()
            .find(|t| t.name == "list_v3_positions")
            .unwrap();
        let props = list.input_schema.get("properties").unwrap();

        assert!(props.get("walletAddress").is_none());
        assert!(props.get("owner").is_none());
        assert_eq!(
            props.as_object().map(|o| o.len()),
            Some(1),
            "chainId should be the only argument"
        );
    }

    // ─── Stage A: live, read-only planning ───────────────────────────────────
    //
    // Ignored by default; run explicitly with a funded-wallet address, an RPC endpoint and an
    // API key:
    //
    //   UNISWAP_API_KEY=... STAGE_A_WALLET=0x... \
    //     cargo test stage_a -- --ignored --nocapture
    //
    // These call `plan_create_v3_position`, never `handle_create_v3_position`. That is the whole
    // point: planning holds no vault, no signer and no DbPool, so no amount of misconfiguration
    // here can broadcast a transaction. The guarantee is structural, not procedural.

    fn stage_a_env() -> Option<(String, Address)> {
        let key = std::env::var("UNISWAP_API_KEY").ok()?;
        if key.is_empty() {
            return None;
        }
        let wallet: Address = std::env::var("STAGE_A_WALLET").ok()?.parse().ok()?;
        let rpc = std::env::var("STAGE_A_RPC_URL")
            .unwrap_or_else(|_| "https://ethereum-sepolia-rpc.publicnode.com".to_string());
        Some((rpc, wallet))
    }

    async fn stage_a_provider(rpc: &str) -> DynProvider {
        ProviderBuilder::new()
            .connect(rpc)
            .await
            .expect("stage A needs a reachable Sepolia RPC")
            .erased()
    }

    #[tokio::test]
    #[ignore = "live: needs UNISWAP_API_KEY and STAGE_A_WALLET"]
    async fn stage_a_position_manager_supports_enumeration() {
        let Some((rpc, wallet)) = stage_a_env() else {
            return;
        };
        let provider = stage_a_provider(&rpc).await;

        let balance = call_view(
            &provider,
            SEPOLIA_V3.position_manager,
            abi_function(position_manager_abi(), "balanceOf").unwrap(),
            &[DynSolValue::Address(wallet)],
        )
        .await
        .expect("balanceOf must work — list_v3_positions depends on ERC-721 enumeration");
        let balance = as_u256(out(&balance, 0, "balanceOf").unwrap(), "balanceOf").unwrap();
        println!("[stage A] balanceOf({wallet:#x}) = {balance}");

        if balance.is_zero() {
            println!("[stage A] wallet holds no positions; tokenOfOwnerByIndex not exercised");
            return;
        }

        let id = call_view(
            &provider,
            SEPOLIA_V3.position_manager,
            abi_function(position_manager_abi(), "tokenOfOwnerByIndex").unwrap(),
            &[
                DynSolValue::Address(wallet),
                DynSolValue::Uint(U256::ZERO, 256),
            ],
        )
        .await
        .expect("tokenOfOwnerByIndex must work on this deployment");
        let id = as_u256(out(&id, 0, "tokenOfOwnerByIndex").unwrap(), "id").unwrap();
        println!("[stage A] tokenOfOwnerByIndex({wallet:#x}, 0) = {id}");
    }

    #[tokio::test]
    #[ignore = "live: needs UNISWAP_API_KEY and STAGE_A_WALLET"]
    async fn stage_a_reads_real_pool_state() {
        let Some((rpc, _wallet)) = stage_a_env() else {
            return;
        };
        let provider = stage_a_provider(&rpc).await;

        let pool = address!("287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7"); // UNI/WETH 0.3%
        let state = read_v3_pool_state(&provider, pool)
            .await
            .expect("a canonical pool must verify against the factory");

        println!(
            "[stage A] pool {pool:#x}: token0={:#x} token1={:#x} fee={} tick={} spacing={} liq={}",
            state.token0,
            state.token1,
            state.fee,
            state.current_tick,
            state.tick_spacing,
            state.liquidity
        );
        assert!(state.tick_spacing > 0);

        // The derived range must bracket the pool's real, live tick — not just a synthetic one.
        let range = derive_tick_range(state.current_tick, state.tick_spacing, 1000).unwrap();
        println!(
            "[stage A] 1000bps range around {}: [{}, {}]",
            state.current_tick, range.lower, range.upper
        );
        assert!(range.lower <= state.current_tick && state.current_tick <= range.upper);
    }

    #[tokio::test]
    #[ignore = "live: needs UNISWAP_API_KEY and STAGE_A_WALLET"]
    async fn stage_a_discovers_pools_by_fee_tier() {
        let Some((rpc, _wallet)) = stage_a_env() else {
            return;
        };
        let provider = stage_a_provider(&rpc).await;

        let uni = address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984");
        let candidates = probe_standard_pools(&provider, SEPOLIA_V3.weth, uni)
            .await
            .expect("probing standard fee tiers should not error");

        for c in &candidates {
            println!(
                "[stage A] fee {:>5}: {:#x} liquidity={}",
                c.fee, c.address, c.liquidity
            );
        }
        let chosen = choose_pool(&candidates).expect("WETH/UNI has at least one funded pool");
        println!(
            "[stage A] chose fee {} at {:#x}",
            chosen.fee, chosen.address
        );
    }

    #[tokio::test]
    #[ignore = "live: needs UNISWAP_API_KEY and STAGE_A_WALLET"]
    async fn stage_a_plans_a_position_without_signing() {
        let Some((rpc, wallet)) = stage_a_env() else {
            return;
        };
        let provider = stage_a_provider(&rpc).await;

        let req = parse_create_request(&args(&[
            ("tokenA", json!("ETH")),
            (
                "tokenB",
                json!("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"),
            ),
            ("maxTokenAAmount", json!("0.01")),
            ("maxTokenBAmount", json!("20")),
            ("rangeWidthBps", json!(1000)),
        ]))
        .expect("request should parse");

        let plan = plan_create_v3_position(&provider, &reqwest::Client::new(), wallet, &req)
            .await
            .expect("planning should succeed against a funded wallet");

        let (a0, a1) = quote_amounts(&plan.quote, &plan.pool).unwrap();
        println!(
            "[stage A] pool={:#x} ({}) fee={} tick={} spacing={}",
            plan.pool_address,
            plan.selection_method,
            plan.pool.fee,
            plan.pool.current_tick,
            plan.pool.tick_spacing
        );
        println!(
            "[stage A] range=[{}, {}]",
            plan.range.lower, plan.range.upper
        );
        println!(
            "[stage A] effective caps: token0={} token1={}",
            format_human_amount(plan.effective0, plan.decimals0),
            format_human_amount(plan.effective1, plan.decimals1)
        );
        println!(
            "[stage A] sized deposit: token0={} token1={} (independent side {:#x})",
            format_human_amount(a0, plan.decimals0),
            format_human_amount(a1, plan.decimals1),
            plan.independent_token
        );

        assert!(
            a0 <= plan.effective0 && a1 <= plan.effective1,
            "quote must fit the budgets"
        );
        assert!(
            plan.range.lower <= plan.pool.current_tick
                && plan.pool.current_tick <= plan.range.upper
        );
    }

    // ─── completed-transaction reporting ─────────────────────────────────────

    #[test]
    fn errors_report_wraps_and_approvals_together() {
        // A wrap moved real funds; if a later stage fails the caller must learn that the wallet
        // now holds WETH it did not before, not just that "the mint failed".
        let completed = vec![
            "0xwrap".to_string(),
            "0xapproval1".to_string(),
            "0xapproval2".to_string(),
        ];
        let err = with_completed_txs::<()>(Err(anyhow::anyhow!("stage=receipt: nope")), &completed)
            .unwrap_err()
            .to_string();

        assert!(
            err.contains("stage=receipt"),
            "original error survives: {err}"
        );
        for hash in &completed {
            assert!(err.contains(hash.as_str()), "{hash} missing from: {err}");
        }
    }

    // ─── minted NFT id ───────────────────────────────────────────────────────

    fn transfer_log(contract: Address, from: Address, to: Address, id: u64) -> PrimitiveLog {
        PrimitiveLog::new_unchecked(
            contract,
            vec![
                ERC721_TRANSFER_TOPIC,
                from.into_word(),
                to.into_word(),
                B256::from(U256::from(id).to_be_bytes::<32>()),
            ],
            Bytes::new(),
        )
    }

    fn mint_log(id: u64) -> PrimitiveLog {
        transfer_log(SEPOLIA_V3.position_manager, Address::ZERO, WALLET, id)
    }

    #[test]
    fn finds_the_minted_token_id() {
        let id =
            parse_minted_token_id(&[mint_log(4242)], SEPOLIA_V3.position_manager, WALLET).unwrap();
        assert_eq!(id, U256::from(4242));
    }

    #[test]
    fn ignores_unrelated_transfers_in_the_same_transaction() {
        // A create transaction also emits ERC-20 Transfers for the deposited tokens, and may
        // touch other NFTs. Matching on topic0 alone would pick up the wrong id.
        let erc20 = address!("fff9976782d46cc05630d1f6ebab18b2324d6b14");
        let logs = vec![
            transfer_log(erc20, WALLET, OTHER, 999),
            transfer_log(erc20, WALLET, SEPOLIA_V3.position_manager, 888),
            mint_log(7),
        ];
        let id = parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, WALLET).unwrap();
        assert_eq!(id, U256::from(7));
    }

    #[test]
    fn rejects_a_mint_to_someone_else() {
        // A Transfer to another address is not our position, and reporting its id would tell
        // the caller they own something they do not.
        let logs = vec![transfer_log(
            SEPOLIA_V3.position_manager,
            Address::ZERO,
            OTHER,
            7,
        )];
        assert!(parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, WALLET).is_err());
    }

    #[test]
    fn rejects_a_transfer_that_is_not_a_mint() {
        // from != 0 means an existing position changed hands, not a new one being created.
        let logs = vec![transfer_log(SEPOLIA_V3.position_manager, OTHER, WALLET, 7)];
        assert!(parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, WALLET).is_err());
    }

    #[test]
    fn rejects_a_mint_from_another_contract() {
        let logs = vec![transfer_log(
            address!("00000000000000000000000000000000deadbeef"),
            Address::ZERO,
            WALLET,
            7,
        )];
        assert!(parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, WALLET).is_err());
    }

    #[test]
    fn rejects_a_receipt_with_no_logs() {
        let err = parse_minted_token_id(&[], SEPOLIA_V3.position_manager, WALLET)
            .expect_err("no logs means no position was minted")
            .to_string();
        assert!(
            err.contains("mint"),
            "error should say a mint was expected: {err}"
        );
    }

    // ─── LP API request bodies ───────────────────────────────────────────────

    fn test_pool() -> V3PoolState {
        V3PoolState {
            token0: address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
            token1: address!("fff9976782d46cc05630d1f6ebab18b2324d6b14"),
            fee: 3000,
            tick_spacing: 60,
            current_tick: -61380,
            sqrt_price_x96: U256::from(1u64) << 96,
            liquidity: U256::from(349461572960640780840u128),
        }
    }

    #[test]
    fn builds_the_documented_create_body() {
        let body = build_lp_create_body(
            &CreateParams {
                wallet: WALLET,
                pool: address!("287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7"),
                pool_tokens: &test_pool(),
                independent_token: address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
                independent_amount: U256::from(198251669183062942u64),
                tick_lower: -198950,
                tick_upper: -198200,
                slippage: Some(0.5),
            },
            true,
        );

        assert_eq!(body["chainId"], json!(11155111));
        assert_eq!(body["protocol"], json!("V3"));
        assert_eq!(
            body["existingPool"]["poolReference"],
            json!("0x287B0e934ed0439E2a7b1d5F0FC25eA2c24b64f7")
        );
        assert_eq!(
            body["independentToken"]["amount"],
            json!("198251669183062942")
        );
        assert_eq!(
            body["tickBounds"],
            json!({"tickLower": -198950, "tickUpper": -198200})
        );
        assert_eq!(body["slippageTolerance"], json!(0.5));
        assert_eq!(body["simulateTransaction"], json!(true));
        // priceBounds is the alternative to tickBounds; sending both is an error.
        assert!(body.get("priceBounds").is_none());
    }

    #[test]
    fn omits_slippage_when_not_supplied_and_can_disable_simulation() {
        let body = build_lp_create_body(
            &CreateParams {
                wallet: WALLET,
                pool: Address::ZERO,
                pool_tokens: &test_pool(),
                independent_token: test_pool().token0,
                independent_amount: U256::from(1u64),
                tick_lower: -10,
                tick_upper: 10,
                slippage: None,
            },
            false,
        );
        assert!(body.get("slippageTolerance").is_none());
        // The sizing pass runs before approvals exist, so simulating it would fail for a reason
        // that says nothing about the position.
        assert_eq!(body["simulateTransaction"], json!(false));
    }

    #[test]
    fn builds_the_documented_check_approval_body() {
        let pool = test_pool();
        let body = build_check_approval_body(
            WALLET,
            &[
                (pool.token0, U256::from(100)),
                (pool.token1, U256::from(200)),
            ],
        );

        assert_eq!(body["action"], json!("CREATE"));
        assert_eq!(body["protocol"], json!("V3"));
        assert_eq!(body["chainId"], json!(11155111));
        assert_eq!(body["generatePermitAsTransaction"], json!(true));
        assert_eq!(body["lpTokens"].as_array().unwrap().len(), 2);
        assert_eq!(body["lpTokens"][0]["amount"], json!("100"));
        assert_eq!(body["lpTokens"][1]["amount"], json!("200"));
    }

    // ─── LP API response parsing ─────────────────────────────────────────────

    #[test]
    fn parses_the_documented_approval_response() {
        let resp = json!({
            "transactions": [
                {"transaction": {"to": "0x1", "data": "0xaa"}, "cancelApproval": false, "action": "CREATE"},
                {"transaction": {"to": "0x2", "data": "0xbb"}, "cancelApproval": true, "action": "CREATE"}
            ]
        });
        let txs = parse_approval_transactions(&resp).unwrap();
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[0]["data"], json!("0xaa"));
        assert_eq!(txs[1]["data"], json!("0xbb"));
    }

    #[test]
    fn treats_an_empty_approval_list_as_nothing_to_do() {
        let txs = parse_approval_transactions(&json!({ "transactions": [] })).unwrap();
        assert!(txs.is_empty());
    }

    #[test]
    fn fails_loudly_on_an_undocumented_approval_shape() {
        // Deliberately no fallback: guessing at an unrecognised shape would mean signing
        // calldata we did not actually parse. Each case must name what was wrong.
        let cases = [
            json!({}),
            json!({"transactions": null}),
            json!({"transactions": {"transaction": {}}}),
            json!({"token0Approval": {"to": "0x1", "data": "0xaa"}}),
            json!({"transactions": [{"cancelApproval": false}]}),
            json!({"transactions": [{"transaction": null}]}),
        ];
        for resp in cases {
            let err = parse_approval_transactions(&resp)
                .expect_err("undocumented shape must not be silently accepted")
                .to_string();
            assert!(
                err.contains("transactions"),
                "error should name the field it could not read, got: {err}"
            );
        }
    }

    #[test]
    fn parses_the_documented_create_response() {
        let resp = json!({
            "requestId": "abc",
            "token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "amount": "100"},
            "token1": {"tokenAddress": "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", "amount": "200"},
            "tickLower": -198950,
            "tickUpper": -198200,
            "adjustedMinPrice": "0.0000000000032",
            "adjustedMaxPrice": "0.0000000000039",
            "create": {"to": "0x1", "from": "0x2", "data": "0xaa", "value": "0", "chainId": 11155111}
        });

        let (addr, amount) = parse_lp_token(&resp, "token0", "/lp/create").unwrap();
        assert_eq!(addr, address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"));
        assert_eq!(amount, U256::from(100));
        assert_eq!(
            parse_lp_token(&resp, "token1", "/lp/create").unwrap().1,
            U256::from(200)
        );
        assert_eq!(
            require_field(&resp, "create", "/lp/create").unwrap()["data"],
            json!("0xaa")
        );
    }

    #[test]
    fn fails_loudly_on_an_undocumented_create_response() {
        assert!(parse_lp_token(&json!({}), "token0", "/lp/create").is_err());
        assert!(
            parse_lp_token(&json!({"token0": {"amount": "1"}}), "token0", "/lp/create").is_err(),
            "a token without tokenAddress must not be accepted"
        );
        assert!(
            parse_lp_token(
                &json!({"token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"}}),
                "token0",
                "/lp/create"
            )
            .is_err(),
            "a token without amount must not be accepted"
        );
        assert!(require_field(&json!({"create": null}), "create", "/lp/create").is_err());
        assert!(require_field(&json!({}), "create", "/lp/create").is_err());
    }

    #[test]
    fn error_excerpts_are_bounded() {
        let huge = "x".repeat(10_000);
        let out = excerpt(&huge);
        assert!(
            out.chars().count() < 700,
            "excerpt should be capped, got {}",
            out.chars().count()
        );
        assert!(out.ends_with("(truncated)"));
        assert_eq!(excerpt("short"), "short");
    }

    // ─── partial-failure reporting ───────────────────────────────────────────

    #[test]
    fn errors_after_an_approval_lands_report_its_hash() {
        // An approval is real on-chain state. If a later step fails, a retry must not look like
        // it is starting from scratch.
        let hashes = vec!["0xaaa".to_string(), "0xbbb".to_string()];
        let err = with_completed_txs::<()>(Err(anyhow::anyhow!("stage=broadcast: nope")), &hashes)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("stage=broadcast"),
            "original error should survive: {err}"
        );
        assert!(
            err.contains("0xaaa") && err.contains("0xbbb"),
            "hashes should be listed: {err}"
        );
    }

    #[test]
    fn errors_before_any_approval_are_left_alone() {
        let err = with_completed_txs::<()>(Err(anyhow::anyhow!("stage=position read: nope")), &[])
            .unwrap_err()
            .to_string();
        assert_eq!(err, "stage=position read: nope");
    }

    // ─── decrease / claim ────────────────────────────────────────────────────

    #[test]
    fn validates_the_liquidity_percentage_range() {
        for (input, expected) in [(json!(1), 1u8), (json!(100), 100), (json!("25"), 25)] {
            let got = parse_liquidity_percentage(&args(&[(
                "liquidityPercentageToDecrease",
                input.clone(),
            )]))
            .unwrap_or_else(|e| panic!("{input} should parse: {e}"));
            assert_eq!(got, expected);
        }

        // 0 would build a no-op transaction that still costs gas; >100 is meaningless.
        for bad in [
            json!(0),
            json!(101),
            json!(-1),
            json!(2.5),
            json!("all"),
            json!(null),
        ] {
            assert!(
                parse_liquidity_percentage(&args(&[(
                    "liquidityPercentageToDecrease",
                    bad.clone()
                )]))
                .is_err(),
                "{bad} should be rejected as a liquidity percentage"
            );
        }
        assert!(parse_liquidity_percentage(&args(&[])).is_err());
    }

    fn test_position() -> V3Position {
        V3Position {
            token0: address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
            token1: address!("fff9976782d46cc05630d1f6ebab18b2324d6b14"),
            fee: 3000,
            tick_lower: -61380,
            tick_upper: -33300,
            liquidity: U256::from(1000u64),
            tokens_owed0: U256::ZERO,
            tokens_owed1: U256::ZERO,
            pool: address!("287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7"),
        }
    }

    #[test]
    fn builds_the_documented_decrease_body() {
        let body = build_lp_decrease_body(
            WALLET,
            &test_position(),
            U256::from(1833079u64),
            100,
            Some(0.5),
        );

        assert_eq!(body["protocol"], json!("V3"));
        assert_eq!(body["chainId"], json!(11155111));
        assert_eq!(body["nftTokenId"], json!("1833079"));
        assert_eq!(body["liquidityPercentageToDecrease"], json!(100));
        assert_eq!(body["withdrawAsWeth"], json!(true));
        assert_eq!(body["simulateTransaction"], json!(true));
        assert_eq!(body["slippageTolerance"], json!(0.5));
        // Token addresses come from the position NFT, never from the caller.
        assert_eq!(
            body["token0Address"],
            json!("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984")
        );
        assert_eq!(
            body["token1Address"],
            json!("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14")
        );
    }

    #[test]
    fn omits_slippage_from_the_decrease_body_when_not_supplied() {
        let body = build_lp_decrease_body(WALLET, &test_position(), U256::from(1u64), 50, None);
        assert!(body.get("slippageTolerance").is_none());
    }

    #[test]
    fn builds_the_documented_claim_fees_body() {
        let body = build_lp_claim_fees_body(WALLET, U256::from(1833079u64));

        assert_eq!(body["protocol"], json!("V3"));
        assert_eq!(body["chainId"], json!(11155111));
        // claim_fees names the id "tokenId", unlike decrease's "nftTokenId".
        assert_eq!(body["tokenId"], json!("1833079"));
        assert!(body.get("nftTokenId").is_none());
        assert_eq!(body["collectAsWeth"], json!(true));
        assert_eq!(body["simulateTransaction"], json!(true));
    }

    #[test]
    fn parses_the_documented_decrease_and_claim_responses() {
        let decrease = json!({
            "requestId": "abc",
            "token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "amount": "10"},
            "token1": {"tokenAddress": "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", "amount": "20"},
            "decrease": {"to": "0x1", "from": "0x2", "data": "0xaa", "chainId": 11155111}
        });
        assert_eq!(
            parse_lp_token(&decrease, "token0", "/lp/decrease")
                .unwrap()
                .1,
            U256::from(10)
        );
        assert!(require_field(&decrease, "decrease", "/lp/decrease").is_ok());
        // The create/claim field names must not be accepted on a decrease response.
        assert!(require_field(&decrease, "create", "/lp/decrease").is_err());

        let claim = json!({
            "token0": {"tokenAddress": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "amount": "3"},
            "token1": {"tokenAddress": "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", "amount": "4"},
            "claim": {"to": "0x1", "from": "0x2", "data": "0xbb", "chainId": 11155111}
        });
        assert_eq!(
            parse_lp_token(&claim, "token1", "/lp/claim_fees")
                .unwrap()
                .1,
            U256::from(4)
        );
        assert!(require_field(&claim, "claim", "/lp/claim_fees").is_ok());
    }

    // ─── tool schema ─────────────────────────────────────────────────────────

    #[test]
    fn every_lp_tool_is_pinned_to_sepolia() {
        let tools = build_uniswap_lp_tools();
        assert_eq!(tools.len(), 6);

        for tool in &tools {
            let props = tool.input_schema.get("properties").unwrap();
            assert_eq!(
                props["chainId"]["enum"],
                json!(["11155111"]),
                "{} should advertise Sepolia as the only chain",
                tool.name
            );
        }
    }

    #[test]
    fn lp_tool_schemas_require_the_right_arguments() {
        let tools = build_uniswap_lp_tools();
        let required = |name: &str| {
            tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("{name} should be listed"))
                .input_schema["required"]
                .clone()
        };

        assert_eq!(
            required("get_v3_position"),
            json!(["chainId", "nftTokenId"])
        );
        assert_eq!(required("claim_v3_fees"), json!(["chainId", "nftTokenId"]));
        assert_eq!(
            required("decrease_v3_position"),
            json!(["chainId", "nftTokenId", "liquidityPercentageToDecrease"])
        );
        assert_eq!(
            required("create_v3_position"),
            json!([
                "chainId",
                "tokenA",
                "tokenB",
                "maxTokenAAmount",
                "maxTokenBAmount"
            ])
        );
    }

    // ─── audit: corrected fee semantics in tool descriptions ─────────────────

    fn description_of(name: &str) -> String {
        build_uniswap_lp_tools()
            .into_iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("{name} should be listed"))
            .description
            .clone()
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn get_v3_position_does_not_present_tokens_owed_as_live_fees() {
        let d = description_of("get_v3_position");

        // It must say the values are cached/stale, not simply "uncollected fees" — an agent
        // reading a stale zero as "no fees owed" would skip a claim it should have made.
        assert!(
            d.contains("cached"),
            "description should say tokensOwed is cached: {d}"
        );
        assert!(
            d.contains("NOT the position's current claimable fees"),
            "description should deny the live-fee reading: {d}"
        );
        assert!(
            !d.contains("and uncollected fees"),
            "the old 'liquidity and uncollected fees' phrasing is what misled: {d}"
        );
    }

    #[test]
    fn decrease_description_says_it_also_collects_fees() {
        let d = description_of("decrease_v3_position");

        // V3's decreaseLiquidity credits accrued fees to the position and the withdrawal sweeps
        // them out, so the previous "does not claim fees" claim was simply wrong.
        assert!(
            d.contains("also collects the position's accrued fees"),
            "description should state that decrease collects fees: {d}"
        );
        assert!(
            !d.contains("does not claim fees"),
            "the incorrect 'does not claim fees' claim must not come back: {d}"
        );
        // Verified against Sepolia position #1: a 25% decrease reported token0: 0 while the
        // same position's claimable token0 was 1.2e19. The fees are collected but not reported,
        // so an agent treating the returned amounts as the total received would under-count.
        assert!(
            d.contains("NOT the fees swept alongside it"),
            "description must warn that returned amounts exclude the swept fees: {d}"
        );
    }

    #[test]
    fn claim_description_does_not_imply_it_is_needed_before_a_decrease() {
        let d = description_of("claim_v3_fees");
        assert!(
            d.contains("not a prerequisite for decrease_v3_position"),
            "description should tell the agent not to claim before decreasing: {d}"
        );
    }

    /// The public interface must not leak the low-level concepts it exists to hide. A model that
    /// sees a `tickLower` field will try to compute one, which is exactly the failure this
    /// interface was rewritten to prevent.
    #[test]
    fn create_exposes_no_raw_ticks_or_smallest_unit_amounts() {
        let tools = build_uniswap_lp_tools();
        let create = tools
            .iter()
            .find(|t| t.name == "create_v3_position")
            .unwrap();
        let props = create.input_schema.get("properties").unwrap();

        for gone in [
            "tickLower",
            "tickUpper",
            "independentTokenAddress",
            "independentTokenAmount",
            "token0Address",
            "token1Address",
        ] {
            assert!(
                props.get(gone).is_none(),
                "{gone} must not be part of the public schema any more"
            );
        }

        for present in [
            "tokenA",
            "tokenB",
            "maxTokenAAmount",
            "maxTokenBAmount",
            "rangeWidthBps",
            "poolAddress",
        ] {
            assert!(props.get(present).is_some(), "{present} should be offered");
        }

        // poolAddress stays available for nonstandard-fee pools, but must not be demanded.
        assert_eq!(
            create.input_schema["required"],
            json!([
                "chainId",
                "tokenA",
                "tokenB",
                "maxTokenAAmount",
                "maxTokenBAmount"
            ])
        );
    }
}

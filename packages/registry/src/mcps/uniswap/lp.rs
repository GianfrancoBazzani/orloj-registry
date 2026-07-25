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
// ---------------------------------------------------------------------------

pub struct SepoliaV3Deployment {
    pub chain_id: u64,
    pub factory: Address,
    pub position_manager: Address,
}

pub const SEPOLIA_V3: SepoliaV3Deployment = SepoliaV3Deployment {
    chain_id: 11155111,
    factory: address!("0227628f3F023bb0B980b67D528571c95c6DaC1c"),
    position_manager: address!("1238536071E1c677A632429e3655c799b22cDA52"),
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
   "outputs":[{"name":"","type":"uint24"}]}
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

/// A V3 pool's token pair, read from the pool itself and verified against the factory.
pub struct V3Pool {
    pub token0: Address,
    pub token1: Address,
}

/// Reads a pool's own token pair and fee tier, then proves the address really is a V3 pool from
/// the canonical Sepolia factory by round-tripping it through `getPool`.
///
/// This is what lets `create_v3_position` drop `token0Address`/`token1Address` from its tool
/// arguments: the caller supplies only a pool, and the token pair it will be asked to approve
/// spending on is derived from that pool rather than asserted alongside it. Taking both from the
/// caller would let a model pair a real pool with unrelated token addresses and get approvals
/// issued for the wrong assets. An arbitrary contract that merely answers token0()/token1()/fee()
/// fails the factory round-trip.
async fn read_v3_pool(provider: &impl Provider, pool: Address) -> Result<V3Pool> {
    let abi = pool_abi();

    let t0 = call_view(provider, pool, abi_function(abi, "token0")?, &[])
        .await
        .with_context(|| format!("{pool:#x} does not answer token0() — not a Uniswap V3 pool"))?;
    let t1 = call_view(provider, pool, abi_function(abi, "token1")?, &[]).await?;
    let f = call_view(provider, pool, abi_function(abi, "fee")?, &[]).await?;

    let token0 = as_address(out(&t0, 0, "pool.token0")?, "pool.token0")?;
    let token1 = as_address(out(&t1, 0, "pool.token1")?, "pool.token1")?;
    let fee = as_u32(out(&f, 0, "pool.fee")?, "pool.fee")?;

    let canonical = get_pool(provider, token0, token1, fee).await?;
    anyhow::ensure!(
        canonical == pool,
        "{pool:#x} is not a canonical Uniswap V3 pool on Sepolia — the factory maps \
         {token0:#x}/{token1:#x} at fee tier {fee} to {canonical:#x}"
    );

    Ok(V3Pool { token0, token1 })
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

/// POST /lp/create body for a position in an *existing* pool.
///
/// `simulate` is false for the pre-approval call that only exists to learn the dependent token
/// amount — the wallet may not hold the allowances yet, so server-side simulation would fail for
/// a reason that says nothing about whether the position is valid. It is true for the refetch
/// after approvals confirm, when a simulation failure is real signal.
/// Everything /lp/create needs about the position being opened. Grouped, following the
/// `QuoteParams` / `SignTransactionParams` convention elsewhere in the crate, so the two passes
/// over the same position differ only in `simulate`.
struct CreateParams<'a> {
    wallet: Address,
    pool: Address,
    pool_tokens: &'a V3Pool,
    independent_token: Address,
    independent_amount: &'a str,
    tick_lower: i32,
    tick_upper: i32,
    slippage: Option<f64>,
}

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
            "amount": p.independent_amount,
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

/// A smallest-unit token amount: strictly decimal and non-zero.
fn parse_amount_arg(args: &Map<String, Value>, key: &str) -> Result<String> {
    let s = args
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing '{key}' argument (decimal string, smallest unit)"))?
        .to_string();

    anyhow::ensure!(
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
        "'{key}' must be a decimal string in the token's smallest unit, got {s:?}"
    );

    let amount =
        U256::from_str_radix(&s, 10).with_context(|| format!("'{key}' {s:?} is out of range"))?;
    anyhow::ensure!(!amount.is_zero(), "'{key}' must be greater than zero");

    Ok(s)
}

fn parse_tick_arg(args: &Map<String, Value>, key: &str) -> Result<i32> {
    let v = args
        .get(key)
        .ok_or_else(|| anyhow::anyhow!("missing '{key}' argument"))?;

    let tick = match v {
        Value::Number(n) => n.as_i64(),
        // Accepted because MCP clients that render everything as text tend to send ticks as
        // strings; the value still has to be a plain integer.
        Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
    .ok_or_else(|| anyhow::anyhow!("'{key}' must be an integer tick, got {v}"))?;

    i32::try_from(tick).with_context(|| format!("'{key}' {tick} is outside the int24 tick range"))
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

/// Appends any already-broadcast approval hashes to an error.
///
/// Approvals are real on-chain state changes. If the flow dies after some of them land, the
/// caller has to know which ones actually happened — otherwise a retry looks like it is starting
/// from scratch when it isn't.
fn with_approvals<T>(result: Result<T>, approval_hashes: &[String]) -> Result<T> {
    match result {
        Ok(v) => Ok(v),
        Err(e) if approval_hashes.is_empty() => Err(e),
        Err(e) => Err(anyhow::anyhow!(
            "{e:#} (completed approval transactions: {})",
            approval_hashes.join(", ")
        )),
    }
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
        "Open a new Uniswap V3 liquidity position in an EXISTING pool on Ethereum Sepolia, on \
         behalf of the authenticated agent. Fully automatic and fund-moving: it derives the \
         pool's token pair on-chain, sizes the position, issues and confirms any required token \
         approvals, then simulates, signs and broadcasts the mint through the agent's vault — \
         you never supply a wallet address, private key or rpc_url. Does not create new pools. \
         You give one side of the position (independentTokenAmount) and Uniswap derives the \
         other. Returns the transaction hash and the new position NFT's token id."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                (
                    "poolAddress",
                    json!({
                        "type": "string",
                        "description": "Address of an existing Uniswap V3 pool on Sepolia. The pool's \
                                        token0, token1 and fee tier are read from the pool itself and \
                                        verified against the V3 factory, so you do not pass them."
                    }),
                ),
                (
                    "independentTokenAddress",
                    json!({
                        "type": "string",
                        "description": "Which side of the pair you are specifying an amount for. Must \
                                        be the pool's token0 or token1; the other side's amount is \
                                        derived by Uniswap from the price range."
                    }),
                ),
                (
                    "independentTokenAmount",
                    json!({
                        "type": "string",
                        "description": "Amount of independentTokenAddress to deposit, in that token's \
                                        smallest unit, as a decimal string (e.g. wei for an \
                                        18-decimal token). Must be greater than zero."
                    }),
                ),
                (
                    "tickLower",
                    json!({
                        "type": "integer",
                        "description": "Lower tick of the position's price range. Ticks are a \
                                        LOG-SCALE price coordinate, not a linear offset or a \
                                        percentage: raw price (token1's smallest unit per token0's \
                                        smallest unit) = 1.0001^tick. This is unrelated to the \
                                        tokens' human decimals, so small integers like 1000-2000 do \
                                        NOT mean 'near the current price' — for most real pools the \
                                        current tick is a large number (tens or hundreds of \
                                        thousands, positive or negative). Must be less than \
                                        tickUpper and an exact multiple of the pool's tick spacing \
                                        (standard V3 fee tiers: 1 for 0.01% fee, 10 for 0.05%, 60 \
                                        for 0.3%, 200 for 1% — confirm against the pool itself, \
                                        since nonstandard tiers exist). \
                                        CRITICAL: this tool has no way to tell you the pool's \
                                        current tick, so you must determine it yourself before \
                                        picking bounds — eth_call the pool's slot0() (returns \
                                        sqrtPriceX96 and tick as its first two return values) or \
                                        tickLower/tickUpper of an existing position via \
                                        get_v3_position. A range that does not bracket the current \
                                        tick silently creates a one-sided position (all of one \
                                        token, none of the other): if the current tick is above \
                                        tickUpper the position needs zero token0, if it's below \
                                        tickLower it needs zero token1 — supplying \
                                        independentTokenAddress as the zero side is a mismatch that \
                                        will fail simulation with an unhelpful bare revert rather \
                                        than a clear error."
                    }),
                ),
                (
                    "tickUpper",
                    json!({
                        "type": "integer",
                        "description": "Upper tick of the position's price range. Must be greater \
                                        than tickLower and a multiple of the pool's tick spacing. \
                                        See tickLower's description — ticks are log-scale \
                                        (price = 1.0001^tick) and this range must bracket the \
                                        pool's actual current tick, which you need to look up \
                                        on-chain (pool.slot0()) before calling this tool."
                    }),
                ),
                ("slippageTolerance", slippage_prop()),
            ],
            &[
                "chainId",
                "poolAddress",
                "independentTokenAddress",
                "independentTokenAmount",
                "tickLower",
                "tickUpper",
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

    vec![
        get_v3_position,
        create_v3_position,
        decrease_v3_position,
        claim_v3_fees,
    ]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

impl UniswapMcpServer {
    /// Everything an LP tool needs before it can do anything: who is acting, where to sign, and
    /// what to talk to. None of it is a tool argument — the wallet comes from the agent's vault
    /// and the rpc_url from the `networks` table.
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

        Ok(LpSession {
            agent_id,
            db,
            wallet,
            provider: provider.erased(),
            rpc_url,
        })
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
    /// The sequence is: read the pool → size the position → approve → re-price → simulate →
    /// broadcast. Each `stage=` context marks which of those failed, and any approval that has
    /// already landed on-chain is reported alongside the error.
    pub(super) async fn handle_create_v3_position(
        &self,
        args: &Map<String, Value>,
    ) -> Result<String> {
        require_sepolia(args)?;
        let pool_address = parse_address_arg(args, "poolAddress")?;
        let independent_token = parse_address_arg(args, "independentTokenAddress")?;
        let independent_amount = parse_amount_arg(args, "independentTokenAmount")?;
        let tick_lower = parse_tick_arg(args, "tickLower")?;
        let tick_upper = parse_tick_arg(args, "tickUpper")?;
        let slippage = parse_slippage_arg(args)?;

        anyhow::ensure!(
            tick_lower < tick_upper,
            "tickLower ({tick_lower}) must be strictly less than tickUpper ({tick_upper})"
        );

        let s = self.lp_session("create_v3_position").await?;

        // The token pair comes from the pool, never from the caller — see read_v3_pool.
        let pool_tokens = read_v3_pool(&s.provider, pool_address)
            .await
            .context("stage=position read")?;

        anyhow::ensure!(
            independent_token == pool_tokens.token0 || independent_token == pool_tokens.token1,
            "independentTokenAddress {independent_token:#x} is not in pool {pool_address:#x}, \
             whose tokens are {:#x} and {:#x}",
            pool_tokens.token0,
            pool_tokens.token1
        );

        let create_params = CreateParams {
            wallet: s.wallet,
            pool: pool_address,
            pool_tokens: &pool_tokens,
            independent_token,
            independent_amount: &independent_amount,
            tick_lower,
            tick_upper,
            slippage,
        };

        // Pass 1 — sizing only. Simulation is off: allowances may not exist yet, and a
        // simulation failure for that reason would say nothing about the position itself.
        let sizing = lp_post(
            &self.http,
            "/lp/create",
            &build_lp_create_body(&create_params, false),
        )
        .await
        .context("stage=API request")?;
        let want0 = parse_lp_token(&sizing, "token0", "/lp/create").context("stage=API request")?;
        let want1 = parse_lp_token(&sizing, "token1", "/lp/create").context("stage=API request")?;

        // These amounts are about to become spending approvals, so the pair they name has to be
        // the pair we read off the pool — not merely whatever the API replied with.
        ensure_pair_matches(
            (want0.0, want1.0),
            (pool_tokens.token0, pool_tokens.token1),
            "/lp/create",
        )
        .context("stage=API request")?;

        // Approvals, one at a time, each confirmed before the next is sent.
        let approval_resp = lp_post(
            &self.http,
            "/lp/check_approval",
            &build_check_approval_body(s.wallet, &[want0, want1]),
        )
        .await
        .context("stage=API request")?;
        let approvals = parse_approval_transactions(&approval_resp).context("stage=API request")?;

        let mut approval_hashes: Vec<String> = Vec::new();
        for (i, approval) in approvals.iter().enumerate() {
            let step = format!("approval {}/{}", i + 1, approvals.len());

            // No destination pin here: an approval's `to` is legitimately the ERC-20 being
            // approved, which varies per pool.
            let validated = with_approvals(
                validate_api_transaction(approval, s.wallet, SEPOLIA_V3.chain_id, None)
                    .with_context(|| format!("stage=approval ({step})")),
                &approval_hashes,
            )?;

            // Simulate before signing. An approval is a real state change that cannot be
            // un-broadcast, and a reverting one would otherwise burn gas and leave the flow
            // half-done — with the mint still doomed to fail for want of an allowance.
            with_approvals(
                simulate_tx(&s.provider, s.wallet, &validated)
                    .await
                    .with_context(|| format!("stage=simulation ({step})")),
                &approval_hashes,
            )?;

            let hash = with_approvals(
                s.sign_and_broadcast(&validated)
                    .await
                    .with_context(|| format!("stage=broadcast ({step})")),
                &approval_hashes,
            )?;
            approval_hashes.push(format!("{hash:#x}"));

            with_approvals(
                wait_for_receipt(&s.provider, hash, &step)
                    .await
                    .with_context(|| format!("stage=receipt ({step})")),
                &approval_hashes,
            )?;
        }

        // Pass 2 — the transaction we will actually sign. Refetched because the approvals just
        // took real block time, which staleifies the deadline the first response carried, and
        // because only now can the server-side simulation mean anything.
        let created = with_approvals(
            lp_post(
                &self.http,
                "/lp/create",
                &build_lp_create_body(&create_params, true),
            )
            .await
            .context("stage=API request"),
            &approval_hashes,
        )?;

        let token0 = with_approvals(
            parse_lp_token(&created, "token0", "/lp/create").context("stage=API request"),
            &approval_hashes,
        )?;
        let token1 = with_approvals(
            parse_lp_token(&created, "token1", "/lp/create").context("stage=API request"),
            &approval_hashes,
        )?;

        // The refetch is a fresh response and gets the same treatment as the first — these are
        // the amounts and addresses reported back to the caller as what was actually deposited.
        with_approvals(
            ensure_pair_matches(
                (token0.0, token1.0),
                (pool_tokens.token0, pool_tokens.token1),
                "/lp/create",
            )
            .context("stage=API request"),
            &approval_hashes,
        )?;

        let create_tx = with_approvals(
            require_field(&created, "create", "/lp/create").context("stage=API request"),
            &approval_hashes,
        )?;

        let validated = with_approvals(
            validate_api_transaction(
                create_tx,
                s.wallet,
                SEPOLIA_V3.chain_id,
                Some(SEPOLIA_V3.position_manager),
            )
            .context("stage=simulation"),
            &approval_hashes,
        )?;

        with_approvals(
            simulate_tx(&s.provider, s.wallet, &validated)
                .await
                .context("stage=simulation"),
            &approval_hashes,
        )?;

        let hash = with_approvals(
            s.sign_and_broadcast(&validated)
                .await
                .context("stage=broadcast"),
            &approval_hashes,
        )?;

        let receipt = with_approvals(
            wait_for_receipt(&s.provider, hash, "position create")
                .await
                .context("stage=receipt"),
            &approval_hashes,
        )?;

        let logs: Vec<PrimitiveLog> = receipt
            .inner
            .logs()
            .iter()
            .map(|log| log.inner.clone())
            .collect();

        let nft_token_id = with_approvals(
            parse_minted_token_id(&logs, SEPOLIA_V3.position_manager, s.wallet)
                .context("stage=receipt"),
            &approval_hashes,
        )?;

        Ok(json!({
            "hash": format!("{hash:#x}"),
            "nftTokenId": nft_token_id.to_string(),
            "poolAddress": pool_address.to_checksum(None),
            "tickLower": created.get("tickLower").cloned().unwrap_or(json!(tick_lower)),
            "tickUpper": created.get("tickUpper").cloned().unwrap_or(json!(tick_upper)),
            "adjustedMinPrice": created.get("adjustedMinPrice").cloned().unwrap_or(Value::Null),
            "adjustedMaxPrice": created.get("adjustedMaxPrice").cloned().unwrap_or(Value::Null),
            "token0": lp_token_json(&token0),
            "token1": lp_token_json(&token1),
            "approvalHashes": approval_hashes,
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
        for name in ["ownerOf", "positions"] {
            abi_function(position_manager_abi(), name).unwrap();
        }
        abi_function(factory_abi(), "getPool").unwrap();
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
    fn rejects_non_increasing_tick_ranges() {
        // Equal or inverted bounds are not a range. Uniswap would revert, but only after the
        // approvals in front of the mint had already been paid for on-chain.
        for (lower, upper) in [(100, 100), (100, -100), (-100, -200), (0, 0)] {
            let a = args(&[("tickLower", json!(lower)), ("tickUpper", json!(upper))]);
            let l = parse_tick_arg(&a, "tickLower").unwrap();
            let u = parse_tick_arg(&a, "tickUpper").unwrap();
            assert!(
                l >= u,
                "test case ({lower}, {upper}) should be non-increasing"
            );
        }
    }

    #[test]
    fn parses_ticks_as_numbers_or_strings_including_negatives() {
        let a = args(&[
            ("tickLower", json!(-198950)),
            ("tickUpper", json!("-198200")),
        ]);
        assert_eq!(parse_tick_arg(&a, "tickLower").unwrap(), -198950);
        assert_eq!(parse_tick_arg(&a, "tickUpper").unwrap(), -198200);
    }

    #[test]
    fn rejects_unusable_ticks() {
        for bad in [
            json!("abc"),
            json!(1.5),
            json!(null),
            json!(true),
            json!(i64::MAX),
        ] {
            assert!(
                parse_tick_arg(&args(&[("tickLower", bad.clone())]), "tickLower").is_err(),
                "{bad} should not parse as a tick"
            );
        }
        assert!(parse_tick_arg(&args(&[]), "tickLower").is_err());
    }

    #[test]
    fn requires_a_positive_decimal_amount() {
        assert_eq!(
            parse_amount_arg(&args(&[("amt", json!("1000000000000000000"))]), "amt").unwrap(),
            "1000000000000000000"
        );
        for bad in [
            json!("0"),
            json!(""),
            json!("-5"),
            json!("1.5"),
            json!("0x10"),
            json!(5),
        ] {
            assert!(
                parse_amount_arg(&args(&[("amt", bad.clone())]), "amt").is_err(),
                "{bad} should not parse as an amount"
            );
        }
    }

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

    fn test_pool() -> V3Pool {
        V3Pool {
            token0: address!("1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
            token1: address!("fff9976782d46cc05630d1f6ebab18b2324d6b14"),
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
                independent_amount: "198251669183062942",
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
                independent_amount: "1",
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
        let err = with_approvals::<()>(Err(anyhow::anyhow!("stage=broadcast: nope")), &hashes)
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
        let err = with_approvals::<()>(Err(anyhow::anyhow!("stage=position read: nope")), &[])
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
        assert_eq!(tools.len(), 4);

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
                "poolAddress",
                "independentTokenAddress",
                "independentTokenAmount",
                "tickLower",
                "tickUpper"
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

    #[test]
    fn create_does_not_accept_caller_supplied_token_addresses() {
        // The pool's pair is read on-chain instead. Exposing these would let a model pair a
        // real pool with unrelated tokens and get approvals issued for the wrong assets.
        let tools = build_uniswap_lp_tools();
        let create = tools
            .iter()
            .find(|t| t.name == "create_v3_position")
            .unwrap();
        let props = create.input_schema.get("properties").unwrap();

        assert!(props.get("token0Address").is_none());
        assert!(props.get("token1Address").is_none());
        assert!(props.get("independentTokenAddress").is_some());
    }
}

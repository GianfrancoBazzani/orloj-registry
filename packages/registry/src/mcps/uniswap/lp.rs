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
    primitives::{Address, U256, address},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
};
use anyhow::{Context, Result};
use rmcp::model::*;
use serde_json::{Map, Value, json};

use super::UniswapMcpServer;
use crate::vault::sign_transaction::resolve_agent_address;

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

pub(super) fn build_uniswap_lp_tools() -> Vec<Tool> {
    vec![Tool::new(
        "get_v3_position".to_string(),
        "Read a Uniswap V3 liquidity position owned by the authenticated agent on Ethereum \
         Sepolia. Returns the pool, token pair, fee tier, tick range, liquidity and uncollected \
         fees. Read-only: pure on-chain reads, no Uniswap API call, no signing, no funds moved. \
         Fails if the position NFT is not owned by the agent's own wallet."
            .to_string(),
        object_schema(
            vec![
                ("chainId", sepolia_chain_id_prop()),
                ("nftTokenId", nft_token_id_prop()),
            ],
            &["chainId", "nftTokenId"],
        ),
    )]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

impl UniswapMcpServer {
    /// Resolves the authenticated agent's wallet and a Sepolia RPC provider. Every LP tool
    /// starts here; neither the wallet nor the rpc_url is ever a tool argument.
    async fn lp_context(&self, tool: &str) -> Result<(Address, DynProvider)> {
        let agent_id = self
            .agent_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("{tool} requires an authenticated agent"))?;
        let db = self
            .db
            .as_ref()
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

        Ok((wallet, provider.erased()))
    }

    pub(super) async fn handle_get_v3_position(&self, args: &Map<String, Value>) -> Result<String> {
        require_sepolia(args)?;
        let nft_token_id = parse_nft_token_id(args)?;

        let (wallet, provider) = self.lp_context("get_v3_position").await?;

        let pos = read_v3_position(&provider, nft_token_id, wallet)
            .await
            .context("stage=position read")?;

        Ok(json!({
            "chainId": SEPOLIA_V3.chain_id,
            "walletAddress": wallet.to_checksum(None),
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

    // ─── tool schema ─────────────────────────────────────────────────────────

    #[test]
    fn get_v3_position_schema_is_sepolia_only() {
        let tools = build_uniswap_lp_tools();
        let tool = tools
            .iter()
            .find(|t| t.name == "get_v3_position")
            .expect("get_v3_position should be listed");

        let props = tool.input_schema.get("properties").unwrap();
        assert_eq!(props["chainId"]["enum"], json!(["11155111"]));
        assert_eq!(
            tool.input_schema["required"],
            json!(["chainId", "nftTokenId"])
        );
    }
}

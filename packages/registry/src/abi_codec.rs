use alloy::{
    dyn_abi::DynSolValue,
    hex,
    json_abi::{Function, Param},
    primitives::{FixedBytes, I256, U256},
};
use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

// ─── Input schema (ABI → MCP tool params) ────────────────────────────────────

pub fn input_schema(func: &Function, is_write: bool) -> Map<String, Value> {
    let mut properties = Map::new();
    let mut required: Vec<Value> = vec![];

    for (i, param) in func.inputs.iter().enumerate() {
        let name = param_name(&param.name, i);
        properties.insert(
            name.clone(),
            json!({ "type": "string", "description": param.ty }),
        );
        required.push(name.into());
    }

    if is_write {
        properties.insert(
            "native_gas_token_value".to_string(),
            json!({ "type": "string", "description": "wei to send (decimal string), default 0" }),
        );
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(properties));
    schema.insert("required".to_string(), Value::Array(required));
    schema
}

// ─── JSON → DynSolValue ───────────────────────────────────────────────────────

pub fn json_to_dyn_args(func: &Function, args: &Map<String, Value>) -> Result<Vec<DynSolValue>> {
    func.inputs
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = param_name(&p.name, i);
            let val = args.get(&name).unwrap_or(&Value::Null);
            json_to_dyn(val, &p.ty, &p.components)
        })
        .collect()
}

pub fn json_to_dyn(value: &Value, ty: &str, components: &[Param]) -> Result<DynSolValue> {
    if let Some(inner) = ty.strip_suffix("[]") {
        let items = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("expected array for {ty}"))?;
        return Ok(DynSolValue::Array(
            items
                .iter()
                .map(|v| json_to_dyn(v, inner, components))
                .collect::<Result<_>>()?,
        ));
    }
    if let Some(b) = ty.rfind('[') && ty.ends_with(']') {
        let inner = &ty[..b];
        let items = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("expected array for {ty}"))?;
        return Ok(DynSolValue::FixedArray(
            items
                .iter()
                .map(|v| json_to_dyn(v, inner, components))
                .collect::<Result<_>>()?,
        ));
    }
    let s = || {
        value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("expected string for {ty}"))
    };
    match ty {
        "address" => Ok(DynSolValue::Address(
            s()?.parse().context("invalid address")?,
        )),
        "bool" => Ok(DynSolValue::Bool(
            value
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("expected bool"))?,
        )),
        "string" => Ok(DynSolValue::String(s()?.to_string())),
        "bytes" => Ok(DynSolValue::Bytes(hex_decode(s()?)?)),
        "tuple" => {
            let obj = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("expected object for tuple"))?;
            let fields = components
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    json_to_dyn(
                        obj.get(&param_name(&c.name, i)).unwrap_or(&Value::Null),
                        &c.ty,
                        &c.components,
                    )
                })
                .collect::<Result<_>>()?;
            Ok(DynSolValue::Tuple(fields))
        }
        t if t.starts_with("bytes") => {
            let n: usize = t[5..].parse().context("invalid bytesN")?;
            let bytes = hex_decode(s()?)?;
            anyhow::ensure!(bytes.len() == n, "expected {n} bytes, got {}", bytes.len());
            let mut word = [0u8; 32];
            word[..n].copy_from_slice(&bytes);
            Ok(DynSolValue::FixedBytes(FixedBytes::from(word), n))
        }
        t if t.starts_with("uint") => {
            let bits = if t == "uint" {
                256
            } else {
                t[4..].parse().unwrap_or(256)
            };
            Ok(DynSolValue::Uint(
                U256::from_str_radix(s()?, 10).context("invalid uint")?,
                bits,
            ))
        }
        t if t.starts_with("int") => {
            let bits = if t == "int" {
                256
            } else {
                t[3..].parse().unwrap_or(256)
            };
            Ok(DynSolValue::Int(
                s()?.parse::<I256>().context("invalid int")?,
                bits,
            ))
        }
        t => Err(anyhow::anyhow!("unsupported type: {t}")),
    }
}

// ─── DynSolValue → JSON ───────────────────────────────────────────────────────

pub fn dyn_outputs_to_json(values: &[DynSolValue], func: &Function) -> Value {
    match values {
        [] => Value::Null,
        [single] => dyn_to_json(single, func.outputs.first()),
        many => {
            let mut map = Map::new();
            for (i, val) in many.iter().enumerate() {
                let param = func.outputs.get(i);
                let name = param
                    .map(|p| param_name(&p.name, i))
                    .unwrap_or_else(|| format!("result{i}"));
                map.insert(name, dyn_to_json(val, param));
            }
            Value::Object(map)
        }
    }
}

pub fn dyn_to_json(value: &DynSolValue, param: Option<&Param>) -> Value {
    match value {
        DynSolValue::Bool(b) => Value::Bool(*b),
        DynSolValue::Address(a) => Value::String(a.to_checksum(None)),
        DynSolValue::String(s) => Value::String(s.clone()),
        DynSolValue::Bytes(b) => Value::String(hex::encode_prefixed(b)),
        DynSolValue::FixedBytes(b, n) => Value::String(hex::encode_prefixed(&b[..*n])),
        DynSolValue::Uint(n, _) => Value::String(n.to_string()),
        DynSolValue::Int(n, _) => Value::String(n.to_string()),
        DynSolValue::Array(items) | DynSolValue::FixedArray(items) => {
            Value::Array(items.iter().map(|v| dyn_to_json(v, None)).collect())
        }
        DynSolValue::Tuple(fields) => {
            let components = param.map(|p| p.components.as_slice());
            let mut map = Map::new();
            for (i, field) in fields.iter().enumerate() {
                let name = components
                    .and_then(|cs| cs.get(i))
                    .map(|c| param_name(&c.name, i))
                    .unwrap_or_else(|| format!("field{i}"));
                map.insert(name, dyn_to_json(field, None));
            }
            Value::Object(map)
        }
        _ => Value::String(format!("{value:?}")),
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

pub fn value_to_text(v: Value) -> String {
    match v {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    }
}

pub fn param_name(name: &str, idx: usize) -> String {
    if name.is_empty() {
        format!("param{idx}")
    } else {
        name.to_string()
    }
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).context("invalid hex")
}

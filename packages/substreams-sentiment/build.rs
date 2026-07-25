fn main() {
    // Generate typed bindings for the Uniswap V3 Swap event. Using Abigen rather than
    // hand-decoding is what keeps int256 amounts sign-correct: the generated struct
    // types amount0/amount1 as substreams::scalar::BigInt, already decoded as signed.
    // Hand-rolling this is where negative values turn into astronomically large
    // positives.
    substreams_ethereum::Abigen::new("UniswapV3Pool", "abi/uniswap_v3_pool.json")
        .expect("failed to load Uniswap V3 Pool ABI")
        .generate()
        .expect("failed to generate Uniswap V3 Pool bindings")
        .write_to_file("src/abi/uniswap_v3_pool.rs")
        .expect("failed to write Uniswap V3 Pool bindings");

    prost_build::compile_protos(&["proto/sentiment.proto"], &["proto/"]).unwrap();
}

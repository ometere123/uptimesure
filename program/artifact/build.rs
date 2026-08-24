fn main() {
    rialo_build_lib::build_script::setup_polkavm_artifact_build()
        .program_path("..")
        .run()
        .unwrap();

    rialo_venus_build_helper::compile_rex_components("..")
        .expect("Failed to compile UptimeSure REX WASM component");
}

/// Integration test that runs `llvm-dwarfdump --verify` on converted output.
/// Skipped if llvm-dwarfdump is not found on PATH.
use arbitrary::Unstructured;
use source_map_dwarf::{Options, SourceMapInput, convert};
use sourcemap::SourceMapBuilder;
use wasm_smith::{Config, Module};

fn find_dwarfdump() -> Option<std::path::PathBuf> {
    let names = ["llvm-dwarfdump", "llvm-dwarfdump-18", "llvm-dwarfdump-17"];
    for name in names {
        if let Ok(path) = which_simple(name) {
            return Some(path);
        }
    }
    // Homebrew keg-only install (brew install llvm).
    let homebrew_paths = [
        "/opt/homebrew/opt/llvm/bin/llvm-dwarfdump",
        "/usr/local/opt/llvm/bin/llvm-dwarfdump",
    ];
    for path in homebrew_paths {
        let p = std::path::PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn which_simple(name: &str) -> Result<std::path::PathBuf, ()> {
    let path_var = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn make_seed(seed: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(1024);
    for i in 0..128u64 {
        v.extend_from_slice(&(seed ^ (i.wrapping_mul(6364136223846793005))).to_le_bytes());
    }
    v
}

fn generate_module(seed: u64) -> Vec<u8> {
    let seed_data = make_seed(seed);
    let mut u = Unstructured::new(&seed_data);
    let mut config = Config::default();
    config.bulk_memory_enabled = false;
    config.exceptions_enabled = false;
    config.gc_enabled = false;
    config.simd_enabled = false;
    config.relaxed_simd_enabled = false;
    config.min_funcs = 1;
    Module::new(config, &mut u)
        .expect("generate module")
        .to_bytes()
}

fn make_source_map(wasm: &[u8], body_start: u64) -> Vec<u8> {
    let mut builder = SourceMapBuilder::new(None);
    let src = builder.add_source("src/main.ts");
    builder.set_source_contents(src, Some("function foo() { return 42; }"));
    let mut line = 0u32;
    let mut col = 0u32;
    let mut count = 0u32;
    for (offset, &byte) in wasm.iter().enumerate() {
        if offset as u64 <= body_start {
            continue;
        }
        if matches!(byte, 0x00 | 0x01 | 0x0B) && count < 20 {
            builder.add_raw(0, offset as u32, line, col, Some(src), None, false);
            col += 4;
            if col > 80 {
                col = 0;
                line += 1;
            }
            count += 1;
        }
    }
    let mut out = Vec::new();
    builder.into_sourcemap().to_writer(&mut out).unwrap();
    out
}

fn code_section_body_start(wasm: &[u8]) -> Option<u64> {
    use wasmparser::{Parser, Payload};
    for p in Parser::new(0).parse_all(wasm) {
        if let Ok(Payload::CodeSectionStart { range, .. }) = p {
            return Some(range.start as u64);
        }
    }
    None
}

#[test]
fn dwarfdump_verify() {
    let Some(dwarfdump) = find_dwarfdump() else {
        eprintln!("llvm-dwarfdump not found, skipping test");
        return;
    };

    let mut verified = 0;
    let mut unsupported_inputs = 0;
    for seed in 0..256 {
        let wasm = generate_module(seed);
        let Some(body_start) = code_section_body_start(&wasm) else {
            continue;
        };

        let sm_bytes = make_source_map(&wasm, body_start);
        let opts = Options {
            source_map: SourceMapInput::Bytes(sm_bytes),
            ..Default::default()
        };

        let out = convert(&wasm, &opts).unwrap_or_else(|e| panic!("seed={seed}: {e}"));

        let tmp = std::env::temp_dir().join(format!("smd_test_{}_{seed}.wasm", std::process::id()));
        let verify = |bytes: &[u8]| {
            std::fs::write(&tmp, bytes).unwrap();
            let output = std::process::Command::new(&dwarfdump)
                .arg("--verify")
                .arg(&tmp)
                .output()
                .expect("run llvm-dwarfdump");
            std::fs::remove_file(&tmp).unwrap();
            output
        };
        // Some wasm-smith inputs exceed this verifier's object-reader support.
        // Establish that on the original bytes; never excuse a converter-only crash.
        let baseline = verify(&wasm);
        let baseline_stderr = String::from_utf8_lossy(&baseline.stderr);
        if baseline_stderr.contains("LLVM ERROR") || baseline_stderr.contains("Stack dump:") {
            unsupported_inputs += 1;
            eprintln!("seed={seed}: verifier also crashes on original wasm; not verified");
            continue;
        }
        assert!(
            baseline.status.success(),
            "seed={seed}: input verification failed: {baseline_stderr}"
        );

        let output = verify(&out);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "seed={seed}: llvm-dwarfdump --verify failed\nstdout: {}\nstderr: {stderr}",
            String::from_utf8_lossy(&output.stdout),
        );
        verified += 1;
    }
    assert!(
        verified > 0,
        "no converted modules reached DWARF verification"
    );
    eprintln!("verified={verified}, unsupported_inputs={unsupported_inputs}");
}

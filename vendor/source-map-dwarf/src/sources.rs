use std::path::{Path, PathBuf};

use sourcemap::SourceMap;

use crate::{Result, SourceFile};

/// Collect the source files carried inline in `sm`'s `sourcesContent`, parallel
/// to its sources. Sources without inline content are skipped.
pub fn collect(sm: &SourceMap) -> Vec<SourceFile> {
    let mut out = Vec::new();
    for i in 0..sm.get_source_count() {
        let Some(content) = sm.get_source_contents(i) else {
            continue;
        };
        let Some(src_path) = sm.get_source(i) else {
            continue;
        };
        out.push(SourceFile {
            path: src_path.to_string(),
            content: content.as_bytes().to_vec(),
        });
    }
    out
}

fn safe_relative_source_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\0') || path.starts_with('/') {
        return None;
    }
    let normalized = path.replace('\\', "/");
    if normalized.as_bytes().get(1) == Some(&b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        return None;
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            _ => out.push(part),
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// If `sm` has `sourcesContent`, write each source file under `base_dir`.
/// Returns the (possibly re-rooted) list of source paths, parallel to sm's sources.
pub fn materialize(sm: &SourceMap, base_dir: &Path) -> Result<()> {
    for i in 0..sm.get_source_count() {
        let Some(content) = sm.get_source_contents(i) else {
            continue;
        };
        let Some(src_path) = sm.get_source(i) else {
            continue;
        };

        // Source maps are remote input. Never let sourcesContent escape the
        // caller-owned materialization directory.
        let Some(rel) = safe_relative_source_path(src_path) else {
            continue;
        };
        let dest = base_dir.join(rel);

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, content)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_relative_source_path;

    #[test]
    fn source_paths_cannot_escape_materialization_root() {
        assert!(safe_relative_source_path("src/math.cpp").is_some());
        for path in [
            "../escape",
            "a/../../escape",
            "a\\..\\escape",
            "/tmp/x",
            "C:\\tmp\\x",
        ] {
            assert!(safe_relative_source_path(path).is_none(), "{path}");
        }
    }
}

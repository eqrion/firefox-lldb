use std::path::Path;

use sourcemap::SourceMap;

use crate::{Result, SourceFile};

/// Collect the source files carried inline in `sm`'s `sourcesContent`, parallel
/// to its sources. Sources without inline content are skipped.
pub fn collect(sm: &SourceMap) -> Vec<SourceFile> {
    let mut out = Vec::new();
    for i in 0..sm.get_source_count() {
        let Some(content) = sm.get_source_contents(i) else { continue };
        let Some(src_path) = sm.get_source(i) else { continue };
        out.push(SourceFile {
            path: src_path.to_string(),
            content: content.as_bytes().to_vec(),
        });
    }
    out
}

/// If `sm` has `sourcesContent`, write each source file under `base_dir`.
/// Returns the (possibly re-rooted) list of source paths, parallel to sm's sources.
pub fn materialize(sm: &SourceMap, base_dir: &Path) -> Result<()> {
    for i in 0..sm.get_source_count() {
        let Some(content) = sm.get_source_contents(i) else { continue };
        let Some(src_path) = sm.get_source(i) else { continue };

        // Strip any leading slashes/dots so the path is relative.
        let rel = src_path.trim_start_matches('/');
        let dest = base_dir.join(rel);

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, content)?;
    }
    Ok(())
}

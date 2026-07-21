//! Synthetic Wasm address space expected by the gdbstub Wasm
//! extensions.

use crate::api::{Debuggee, Frame, Memory, Module};
use anyhow::Result;
use gdbstub_arch::wasm::addr::{WasmAddr, WasmAddrType};
use std::collections::{BTreeMap, HashMap, HashSet, hash_map::Entry};

/// Representation of the synthesized Wasm address space.
///
/// Modules are keyed by a monotonic id that is never reused, rather than by
/// position in a dense array: a navigation can drop modules from the
/// debuggee's `all_modules()` list (the page they belonged to is gone), and
/// removing a dense-array entry would shift every later module's id — and
/// with it, its `WasmAddr` and any breakpoints LLDB has bound against that
/// address. A stable, sparse id lets a navigation prune the modules that
/// disappeared without disturbing the ones that didn't.
pub struct AddrSpace {
    module_ids: HashMap<u64, u32>,
    memory_ids: HashMap<u64, u32>,
    modules: BTreeMap<u32, Module>,
    module_bytecode: BTreeMap<u32, Vec<u8>>,
    memories: Vec<Memory>,
    next_module_id: u32,
}

/// The result of a lookup in the address space.
pub enum AddrSpaceLookup<'a> {
    Module {
        module: &'a Module,
        bytecode: &'a [u8],
        offset: u32,
    },
    Memory {
        memory: &'a Memory,
        offset: u32,
    },
    Empty,
}

impl AddrSpace {
    pub fn new() -> Self {
        AddrSpace {
            module_ids: HashMap::new(),
            modules: BTreeMap::new(),
            module_bytecode: BTreeMap::new(),
            memory_ids: HashMap::new(),
            memories: vec![],
            next_module_id: 0,
        }
    }

    fn module_id(&mut self, m: &Module) -> u32 {
        match self.module_ids.entry(m.unique_id()) {
            Entry::Occupied(o) => *o.get(),
            Entry::Vacant(v) => {
                let id = self.next_module_id;
                self.next_module_id += 1;
                let bytecode = m.bytecode().unwrap_or(vec![]);
                self.module_bytecode.insert(id, bytecode);
                self.modules.insert(id, m.clone());
                *v.insert(id)
            }
        }
    }

    fn memory_id(&mut self, m: &Memory) -> u32 {
        match self.memory_ids.entry(m.unique_id()) {
            Entry::Occupied(o) => *o.get(),
            Entry::Vacant(v) => {
                let id = u32::try_from(self.memories.len()).unwrap();
                self.memories.push(m.clone());
                *v.insert(id)
            }
        }
    }

    /// Update/create new mappings so that all modules and instances'
    /// memories in the debuggee have mappings, and drop modules that are no
    /// longer present (e.g. the page they belonged to was navigated away).
    /// Returns true if the registered module set changed — grew, shrank, or
    /// both, as when a navigation swaps one page's modules for another's.
    pub fn update(&mut self, d: &Debuggee) -> Result<bool> {
        let mut live_ids = HashSet::with_capacity(self.module_ids.len());
        let mut changed = false;
        for module in d.all_modules() {
            let unique_id = module.unique_id();
            changed |= !self.module_ids.contains_key(&unique_id);
            let _ = self.module_id(&module);
            live_ids.insert(unique_id);
        }
        let dead_ids: Vec<u64> = self
            .module_ids
            .keys()
            .filter(|unique_id| !live_ids.contains(*unique_id))
            .copied()
            .collect();
        for unique_id in dead_ids {
            changed = true;
            let id = self.module_ids.remove(&unique_id).unwrap();
            self.modules.remove(&id);
            self.module_bytecode.remove(&id);
        }
        for instance in d.all_instances() {
            let mut idx = 0;
            loop {
                if let Ok(m) = instance.get_memory(d, idx) {
                    let _ = self.memory_id(&m);
                    idx += 1;
                } else {
                    break;
                }
            }
        }
        Ok(changed)
    }

    pub fn has_modules(&self) -> bool {
        !self.modules.is_empty()
    }

    /// Iterate over each registered module paired with its base `WasmAddr`.
    pub fn modules_with_addrs(&self) -> impl Iterator<Item = (&Module, WasmAddr)> + '_ {
        self.modules.iter().map(|(&id, m)| {
            let addr = WasmAddr::new(WasmAddrType::Object, id, 0).unwrap();
            (m, addr)
        })
    }

    /// Build the GDB memory-map XML describing all known regions.
    ///
    /// Module bytecode regions are reported as `rom` (read-only), and
    /// linear memories as `ram` (read-write).
    pub fn memory_map_xml(&self, debuggee: &Debuggee) -> String {
        use std::fmt::Write;
        let mut xml = String::from(
            "<?xml version=\"1.0\"?><!DOCTYPE memory-map SYSTEM \"memory-map.dtd\"><memory-map>",
        );
        for (&id, bc) in self.module_bytecode.iter() {
            let start = WasmAddr::new(WasmAddrType::Object, id, 0).unwrap();
            let len = bc.len();
            if len > 0 {
                write!(
                    xml,
                    "<memory type=\"rom\" start=\"0x{:x}\" length=\"0x{:x}\"/>",
                    start.as_raw(),
                    len
                )
                .unwrap();
            }
        }
        for (idx, mem) in self.memories.iter().enumerate() {
            let start =
                WasmAddr::new(WasmAddrType::Memory, u32::try_from(idx).unwrap(), 0).unwrap();
            let len = mem.size_bytes(debuggee);
            if len > 0 {
                write!(
                    xml,
                    "<memory type=\"ram\" start=\"0x{:x}\" length=\"0x{:x}\"/>",
                    start.as_raw(),
                    len
                )
                .unwrap();
            }
        }
        xml.push_str("</memory-map>");
        xml
    }

    pub fn frame_to_pc(&self, frame: &Frame, debuggee: &Debuggee) -> WasmAddr {
        let module = frame.get_instance(debuggee).unwrap().get_module(debuggee);
        let &module_id = self
            .module_ids
            .get(&module.unique_id())
            .expect("module not found in addr space");
        let pc = frame.get_pc(debuggee).unwrap();
        WasmAddr::new(WasmAddrType::Object, module_id, pc).unwrap()
    }

    pub fn frame_to_return_addr(&self, frame: &Frame, debuggee: &Debuggee) -> Option<WasmAddr> {
        let module = frame.get_instance(debuggee).unwrap().get_module(debuggee);
        let &module_id = self
            .module_ids
            .get(&module.unique_id())
            .expect("module not found in addr space");
        let ret_pc = frame.get_pc(debuggee).ok()?;
        Some(WasmAddr::new(WasmAddrType::Object, module_id, ret_pc).unwrap())
    }

    pub fn lookup(&self, addr: WasmAddr, d: &Debuggee) -> AddrSpaceLookup<'_> {
        match addr.addr_type() {
            WasmAddrType::Object => {
                // Module ids are sparse (see the AddrSpace doc comment) —
                // look up by id, not by dense position. A stale id from
                // before a navigation pruned it correctly returns Empty
                // rather than aliasing whatever module now occupies that
                // slot.
                let id = addr.module_index();
                let Some(bytecode) = self.module_bytecode.get(&id) else {
                    return AddrSpaceLookup::Empty;
                };
                if addr.offset() >= u32::try_from(bytecode.len()).unwrap() {
                    return AddrSpaceLookup::Empty;
                }
                AddrSpaceLookup::Module {
                    module: self.modules.get(&id).unwrap(),
                    bytecode,
                    offset: addr.offset(),
                }
            }
            WasmAddrType::Memory => {
                let index = usize::try_from(addr.module_index()).unwrap();
                if index >= self.memories.len() {
                    return AddrSpaceLookup::Empty;
                }
                // Do not call size_bytes here: it is an RPC call on the hot
                // path and creates one jco AsyncSubtask per memory read, which
                // leaks ~240 bytes per packet and causes OOM during large reads.
                // #readMemory in rdp-debuggee.ts bounds-checks via JS instead.
                AddrSpaceLookup::Memory {
                    memory: &self.memories[index],
                    offset: addr.offset(),
                }
            }
        }
    }
}

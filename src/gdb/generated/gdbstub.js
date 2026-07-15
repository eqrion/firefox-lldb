"use components";
export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {
  let currentSubtask; // jco-patch
  
  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
  }
  const symbolDispose = Symbol.dispose || Symbol.for('dispose');
  const symbolAsyncIterator = Symbol.asyncIterator;
  const symbolIterator = Symbol.iterator;
  
  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
    console.debug(...args);
  };
  const ASYNC_DETERMINISM = 'random';
  const GLOBAL_COMPONENT_MEMORY_MAP = new Map();
  const CURRENT_TASK_META = {};
  
  function _getGlobalCurrentTaskMeta(componentIdx) {
    if (componentIdx === null || componentIdx === undefined) {
      throw new Error("missing/invalid component idx");
    }
    const v = CURRENT_TASK_META[componentIdx];
    if (v === undefined || v === null) {
      return undefined;
    }
    return { ...v };
  }
  
  
  function _setGlobalCurrentTaskMeta(args) {
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    return CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
  }
  
  
  function _withGlobalCurrentTaskMeta(args) {
    _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return fn();
    } catch (err) {
      _debugLog("error while executing sync callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _withGlobalCurrentTaskMetaAsync(args) {
    _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return await fn();
    } catch (err) {
      _debugLog("error while executing async callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _clearCurrentTask(args) {
    _debugLog('[_clearCurrentTask()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    
    const meta = CURRENT_TASK_META[componentIdx];
    if (!meta) { throw new Error(`missing current task meta for component idx [${componentIdx}]`); }
    
    if (meta.taskID !== taskID) {
      throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx) {
      throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
    }
    
    CURRENT_TASK_META[componentIdx] = null;
  }
  
  function lookupMemoriesForComponent(args) {
    const { componentIdx } = args ?? {};
    if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }
    
    const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!metas) { return []; }
    
    if (args.memoryIdx === undefined) {
      return Object.values(metas);
    }
    
    const meta = metas[args.memoryIdx];
    return meta?.memory;
  }
  
  function registerGlobalMemoryForComponent(args) {
    const { componentIdx, memory, memoryIdx } = args ?? {};
    if (componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (memory === undefined && memoryIdx === undefined) { throw new TypeError('missing both memory & memory idx'); }
    let inner = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!inner) {
      inner = {};
      GLOBAL_COMPONENT_MEMORY_MAP.set(componentIdx, inner);
    }
    
    inner[memoryIdx] = { memory, memoryIdx, componentIdx };
  }
  
  class RepTable {
    #data = [0, null];
    #target;
    
    constructor(args) {
      this.target = args?.target;
    }
    
    data() { return this.#data; }
    
    insert(val) {
      _debugLog('[RepTable#insert()] args', { val, target: this.target });
      const freeIdx = this.#data[0];
      if (freeIdx === 0) {
        this.#data.push(val);
        this.#data.push(null);
        const rep = (this.#data.length >> 1) - 1;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
        return rep;
      }
      this.#data[0] = this.#data[freeIdx << 1];
      const placementIdx = freeIdx << 1;
      this.#data[placementIdx] = val;
      this.#data[placementIdx + 1] = null;
      _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
      return freeIdx;
    }
    
    get(rep) {
      _debugLog('[RepTable#get()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      return val;
    }
    
    contains(rep) {
      _debugLog('[RepTable#contains()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      return !!this.#data[baseIdx];
    }
    
    remove(rep) {
      _debugLog('[RepTable#remove()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
      if (this.#data.length === 2) { throw new Error('invalid'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      
      this.#data[baseIdx] = this.#data[0];
      this.#data[0] = rep;
      
      return val;
    }
    
    clear() {
      _debugLog('[RepTable#clear()] args', { rep, target: this.target });
      this.#data = [0, null];
    }
  }
  const _coinFlip = () => { return Math.random() > 0.5; };
  let SCOPE_ID = 0;
  const I32_MIN = -2_147_483_648;
  
  const I32_MAX= 2_147_483_647;
  
  
  function _isValidNumericPrimitive(ty, v) {
    if (v === undefined || v === null) { return false; }
    switch (ty) {
      case 'bool':
      return v === 0 || v === 1;
      break;
      case 'u8':
      return v >= 0 && v <= 255;
      break;
      case 's8':
      return v >= -128 && v <= 127;
      break;
      case 'u16':
      return v >= 0 && v <= 65535;
      break;
      case 's16':
      return v >= -32768 && v <= 32767;
      case 'u32':
      return v >= 0 && v <= 4_294_967_295;
      case 's32':
      return v >= -2_147_483_648 && v <= 2_147_483_647;
      case 'u64':
      return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
      case 's64':
      return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
      break;
      case 'f32':
      case 'f64': return typeof v === 'number';
      default:
      return false;
    }
    return true;
  }
  
  function _requireValidNumericPrimitive(ty, v) {
    if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }
  
  const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;
  
  
  const _typeCheckAsyncFn= (f) => {
    return f instanceof ASYNC_FN_CTOR;
  };
  
  let RESOURCE_CALL_BORROWS = [];const ASYNC_FN_CTOR = (async () => {}).constructor;
  
  function clearCurrentTask(componentIdx, taskID) {
    _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });
    
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while ending current task');
    }
    
    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('missing/invalid tasks for component instance while ending task');
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
    }
    
    if (taskID !== undefined) {
      const last = tasks[tasks.length - 1];
      if (last.id !== taskID) {
        // throw new Error('current task does not match expected task ID');
        return;
      }
    }
    
    ASYNC_CURRENT_TASK_IDS.pop();
    ASYNC_CURRENT_COMPONENT_IDXS.pop();
    
    const taskMeta = tasks.pop();
    return taskMeta.task;
  }
  
  const CURRENT_TASK_MAY_BLOCK= globalThis.WebAssembly ? new globalThis.WebAssembly.Global({ value: 'i32', mutable: true }, 0) : false;
  
  const ASYNC_CURRENT_TASK_IDS = [];
  const ASYNC_CURRENT_COMPONENT_IDXS = [];
  
  function unpackCallbackResult(result) {
    if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
    const eventCode = result & 0xF;
    if (eventCode < 0 || eventCode > 3) {
      throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
    }
    if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
    // TODO: table max length check?
    const waitableSetRep = result >> 4;
    return [eventCode, waitableSetRep];
  }
  
  class AsyncSubtask {
    static _ID = 0n;
    
    static State = {
      STARTING: 0,
      STARTED: 1,
      RETURNED: 2,
      CANCELLED_BEFORE_STARTED: 3,
      CANCELLED_BEFORE_RETURNED: 4,
    };
    
    #id;
    #state = AsyncSubtask.State.STARTING;
    #componentIdx;
    
    #parentTask;
    #childTask = null;
    
    #dropped = false;
    #cancelRequested = false;
    
    #memoryIdx = null;
    #lenders = null;
    
    #waitable = null;
    
    #callbackFn = null;
    #callbackFnName = null;
    
    #postReturnFn = null;
    #onProgressFn = null;
    #pendingEventFn = null;
    
    #callMetadata = {};
    
    #resolved = false;
    
    #onResolveHandlers = [];
    #onStartHandlers = [];
    
    #result = null;
    #resultSet = false;
    
    fnName;
    target;
    isAsync;
    isManualAsync;
    
    constructor(args) {
      if (typeof args.componentIdx !== 'number') {
        throw new Error('invalid componentIdx for subtask creation');
      }
      this.#componentIdx = args.componentIdx;
      
      this.#id = ++AsyncSubtask._ID;
      this.fnName = args.fnName;
      
      if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
      this.#parentTask = args.parentTask;
      
      if (args.childTask) { this.#childTask = args.childTask; }
      
      if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }
      
      if (!args.waitable) { throw new Error("missing/invalid waitable"); }
      this.#waitable = args.waitable;
      
      if (args.callMetadata) { this.#callMetadata = args.callMetadata; }
      
      this.#lenders = [];
      this.target = args.target;
      this.isAsync = args.isAsync;
      this.isManualAsync = args.isManualAsync;
    }
    
    id() { return this.#id; }
    parentTaskID() { return this.#parentTask?.id(); }
    childTaskID() { return this.#childTask?.id(); }
    state() { return this.#state; }
    
    waitable() { return this.#waitable; }
    waitableRep() { return this.#waitable.idx(); }
    
    join() { return this.#waitable.join(...arguments); }
    getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
    hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
    setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }
    
    setTarget(tgt) { this.target = tgt; }
    
    getResult() {
      if (!this.#resultSet) { throw new Error("subtask result has not been set") }
      return this.#result;
    }
    setResult(v) {
      if (this.#resultSet) { throw new Error("subtask result has already been set"); }
      this.#result = v;
      this.#resultSet = true;
    }
    
    componentIdx() { return this.#componentIdx; }
    
    setChildTask(t) {
      if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
      if (this.#childTask) { throw new Error('child task is already set on subtask'); }
      if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
      this.#childTask = t;
    }
    getChildTask(t) { return this.#childTask; }
    
    getParentTask() { return this.#parentTask; }
    
    setCallbackFn(f, name) {
      if (!f) { return; }
      if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    
    getCallbackFnName() {
      if (!this.#callbackFn) { return undefined; }
      return this.#callbackFn.name;
    }
    
    setPostReturnFn(f) {
      if (!f) { return; }
      if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
      this.#postReturnFn = f;
    }
    
    setOnProgressFn(f) {
      if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
      this.#onProgressFn = f;
    }
    
    isNotStarted() {
      return this.#state == AsyncSubtask.State.STARTING;
    }
    
    registerOnStartHandler(f) {
      this.#onStartHandlers.push(f);
    }
    
    onStart(args) {
      _debugLog('[AsyncSubtask#onStart()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        parentTaskID: this.parentTaskID(),
        fnName: this.fnName,
        args,
      });
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      this.#state = AsyncSubtask.State.STARTED;
      
      let result;
      
      // If we have been provided a helper start function as a result of
      // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
      // be performed for us.
      //
      // See also documentation on `HostIntrinsic::PrepareCall`
      //
      if (this.#callMetadata.startFn) {
        result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
      }
      
      return result;
    }
    
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    reject(subtaskErr) {
      this.#childTask?.reject(subtaskErr);
    }
    
    onResolve(subtaskValue) {
      _debugLog('[AsyncSubtask#onResolve()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        isAsync: this.isAsync,
        childTaskID: this.childTaskID(),
        parentTaskID: this.parentTaskID(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        fnName: this.fnName,
      });
      
      if (this.#resolved) {
        throw new Error('subtask has already been resolved');
      }
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      if (subtaskValue === null && this.#cancelRequested) {
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before cancellation');
          }
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        }
      } else {
        if (this.#state !== AsyncSubtask.State.STARTED) {
          throw new Error('resolved subtask must have been started before completion');
        }
        this.#state = AsyncSubtask.State.RETURNED;
      }
      
      this.setResult(subtaskValue);
      
      for (const f of this.#onResolveHandlers) {
        try {
          f(subtaskValue);
        } catch (err) {
          console.error("error during subtask resolve handler", err);
          throw err;
        }
      }
      
      const callMetadata = this.getCallMetadata();
      
      // TODO(fix): we should be able to easily have the caller's meomry
      // to lower into here, but it's not present in PrepareCall
      const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
      if (callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
        const { resultPtr, realloc } = callMetadata;
        const lowers = callMetadata.lowers; // may have been updated in task.return of the child
        if (lowers && lowers.length > 0) {
          lowers[0]({
            componentIdx: this.#componentIdx,
            memory,
            realloc,
            vals: [subtaskValue],
            storagePtr: resultPtr,
            stringEncoding: callMetadata.stringEncoding,
          });
        }
      }
      
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
      this.#getComponentState().handles.remove(this.waitableRep()); // jco-patch
    }
    
    getStateNumber() { return this.#state; }
    isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }
    
    getCallMetadata() { return this.#callMetadata; }
    
    isResolved() {
      if (this.#state === AsyncSubtask.State.STARTING
      || this.#state === AsyncSubtask.State.STARTED) {
        return false;
      }
      if (this.#state === AsyncSubtask.State.RETURNED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
        return true;
      }
      throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
    }
    
    addLender(handle) {
      _debugLog('[AsyncSubtask#addLender()] args', { handle });
      if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }
      
      if (this.#lenders.length === 0 || this.isResolved()) {
        throw new Error('subtask has no lendors or has already been resolved');
      }
      
      handle.lends++;
      this.#lenders.push(handle);
    }
    
    deliverResolve() {
      _debugLog('[AsyncSubtask#deliverResolve()] args', {
        lenders: this.#lenders,
        parentTaskID: this.parentTaskID(),
        subtaskID: this.#id,
        childTaskID: this.childTaskID(),
        resolved: this.isResolved(),
        resolveDelivered: this.resolveDelivered(),
      });
      
      const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
      if (cannotDeliverResolve) {
        throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
      }
      
      for (const lender of this.#lenders) {
        lender.lends--;
      }
      
      this.#lenders = null;
    }
    
    resolveDelivered() {
      _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
      if (this.#lenders === null && !this.isResolved()) {
        throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
      }
      return this.#lenders === null;
    }
    
    drop() {
      _debugLog('[AsyncSubtask#drop()] args', {
        componentIdx: this.#componentIdx,
        parentTaskID: this.#parentTask?.id(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        childTaskID: this.#childTask?.id(),
        childTaskFnName: this.#childTask?.entryFnName(),
        subtaskFnName: this.fnName,
      });
      if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
      if (!this.resolveDelivered()) {
        throw new Error('cannot drop subtask before resolve is delivered');
      }
      if (this.#waitable) { this.#waitable.drop() }
      this.#dropped = true;
    }
    
    #getComponentState() {
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error('invalid/missing async state for component [' + componentIdx + ']');
      }
      return state;
    }
    
    getWaitableHandleIdx() {
      _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
      if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
      return this.waitableRep();
    }
  }
  
  function _prepareCall(
  memoryIdx,
  getMemoryFn,
  startFn,
  returnFn,
  callerComponentIdx,
  calleeComponentIdx,
  taskReturnTypeIdx,
  calleeIsAsyncInt,
  stringEncoding,
  resultCountOrAsync,
  ) {
    _debugLog('[_prepareCall()]', {
      memoryIdx,
      callerComponentIdx,
      calleeComponentIdx,
      taskReturnTypeIdx,
      calleeIsAsyncInt,
      stringEncoding,
      resultCountOrAsync,
    });
    const argArray = [...arguments];
    
    // value passed in *may* be as large as u32::MAX which may be mangled into -2
    resultCountOrAsync >>>= 0;
    
    let isAsync = false;
    let hasResultPointer = false;
    if (resultCountOrAsync === 2**32 - 1) {
      // prepare async with no result (u32::MAX)
      isAsync = true;
      hasResultPointer = false;
    } else if (resultCountOrAsync === 2**32 - 2) {
      // prepare async with result (u32::MAX - 1)
      isAsync = true;
      hasResultPointer = true;
    }
    
    const currentCallerTaskMeta = getCurrentTask(callerComponentIdx);
    if (!currentCallerTaskMeta) {
      throw new Error('invalid/missing current task for caller during prepare call');
    }
    
    const currentCallerTask = currentCallerTaskMeta.task;
    if (!currentCallerTask) {
      throw new Error('unexpectedly missing task in meta for caller during prepare call');
    }
    
    if (currentCallerTask.componentIdx() !== callerComponentIdx) {
      throw new Error(`task component idx [${ currentCallerTask.componentIdx() }] !== [${ callerComponentIdx }] (callee ${ calleeComponentIdx })`);
    }
    
    let getCalleeParamsFn;
    let resultPtr = null;
    let directParamsArr;
    if (hasResultPointer) {
      directParamsArr = argArray.slice(10, argArray.length - 1);
      getCalleeParamsFn = () => directParamsArr;
      resultPtr = argArray[argArray.length - 1];
    } else {
      directParamsArr = argArray.slice(10);
      getCalleeParamsFn = () => directParamsArr;
    }
    
    let encoding;
    switch (stringEncoding) {
      case 0:
      encoding = 'utf8';
      break;
      case 1:
      encoding = 'utf16';
      break;
      case 2:
      encoding = 'compact-utf16';
      break;
      default:
      throw new Error(`unrecognized string encoding enum [${stringEncoding}]`);
    }
    
    const subtask = currentCallerTask.createSubtask({
      componentIdx: callerComponentIdx,
      parentTask: currentCallerTask,
      isAsync,
      callMetadata: {
        getMemoryFn,
        memoryIdx,
        resultPtr,
        returnFn,
        startFn,
        stringEncoding,
      }
    });
    
    const [newTask, newTaskID] = createNewCurrentTask({
      componentIdx: calleeComponentIdx,
      isAsync,
      getCalleeParamsFn,
      entryFnName: [
      'task',
      subtask.getParentTask().id(),
      'subtask',
      subtask.id(),
      'new-prepared-async-task'
      ].join('/'),
      stringEncoding,
    });
    newTask.setParentSubtask(subtask);
    newTask.setReturnMemoryIdx(memoryIdx);
    newTask.setReturnMemory(getMemoryFn);
    subtask.setChildTask(newTask);
    
    newTask.subtaskMeta = {
      subtask,
      calleeComponentIdx,
      callerComponentIdx,
      getCalleeParamsFn,
      stringEncoding,
      isAsync,
    };
    
    _setGlobalCurrentTaskMeta({
      taskID: newTask.id(),
      componentIdx: newTask.componentIdx(),
    });
  }
  
  function _asyncStartCall(args, callee, paramCount, resultCount, flags) {
    const componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
    
    const globalTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
    if (!globalTaskMeta) { throw new Error('missing global current task globalTaskMeta'); }
    const taskID = globalTaskMeta.taskID;
    
    _debugLog('[_asyncStartCall()] args', { args, componentIdx });
    const { getCallbackFn, callbackIdx, getPostReturnFn, postReturnIdx } = args;
    
    const preparedTaskMeta = getCurrentTask(componentIdx, taskID);
    if (!preparedTaskMeta) { throw new Error('unexpectedly missing current task'); }
    
    const preparedTask = preparedTaskMeta.task;
    if (!preparedTask) { throw new Error('unexpectedly missing current task'); }
    if (!preparedTask.subtaskMeta) { throw new Error('missing subtask meta from prepare'); }
    
    const {
      subtask,
      returnMemoryIdx,
      getReturnMemoryFn,
      callerComponentIdx,
      calleeComponentIdx,
      getCalleeParamsFn,
      isAsync,
      stringEncoding,
    } = preparedTask.subtaskMeta;
    if (!subtask) { throw new Error("missing subtask from cstate during async start call"); }
    if (calleeComponentIdx !== preparedTask.componentIdx()) {
      throw new Error(`meta callee idx [${calleeComponentIdx}] != current task idx [${preparedTask.componentIdx()}] during async start call`);
    }
    if (calleeComponentIdx !== componentIdx) {
      throw new Error("mismatched componentIdx for async start call (does not match prepare)");
    }
    
    const argArray = [...arguments];
    
    if (resultCount < 0 || resultCount > 1) { throw new Error('invalid/unsupported result count'); }
    
    const callbackFnName = 'callback_' + callbackIdx;
    const callbackFn = getCallbackFn();
    preparedTask.setCallbackFn(callbackFn, callbackFnName);
    preparedTask.setPostReturnFn(getPostReturnFn());
    
    if (resultCount < 0 || resultCount > 1) {
      throw new Error(`unsupported result count [${ resultCount }]`);
    }
    
    const params = preparedTask.getCalleeParams();
    if (paramCount !== params.length) {
      throw new Error(`unexpected callee param count [${ params.length }], _asyncStartCall invocation expected [${ paramCount }]`);
    }
    
    const callerComponentState = getOrCreateAsyncState(subtask.componentIdx());
    
    const calleeComponentState = getOrCreateAsyncState(preparedTask.componentIdx());
    const calleeBackpressure = calleeComponentState.hasBackpressure();
    
    // Set up a handler on subtask completion to lower results from the call into the caller's memory region.
    //
    // NOTE: during fused guest->guest calls this handler is triggered, but does not actually perform
    // lowering manually, as fused modules provider helper functions that can
    subtask.registerOnResolveHandler((res) => {
      _debugLog('[_asyncStartCall()] handling subtask result', { res, subtaskID: subtask.id() });
      
      let subtaskCallMeta = subtask.getCallMetadata();
      
      // NOTE: in the case of guest -> guest async calls, there may be no memory/realloc present,
      // as the host will intermediate the value storage/movement between calls.
      //
      // We can simply take the value and lower it as a parameter
      if (subtaskCallMeta.memory || subtaskCallMeta.realloc) {
        throw new Error("call metadata unexpectedly contains memory/realloc for guest->guest call");
      }
      
      const callerTask = subtask.getParentTask();
      const calleeTask = preparedTask;
      const callerMemoryIdx = callerTask.getReturnMemoryIdx();
      const callerComponentIdx = callerTask.componentIdx();
      
      // If a helper function was provided we are likely in a fused guest->guest call,
      // and the result will be delivered (lift/lowered) via helper function
      if (subtaskCallMeta && subtaskCallMeta.returnFn) {
        _debugLog('[_asyncStartCall()] return function present while handling subtask result, returning early (skipping lower)', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
        });
        
        // TODO: centralize calling of returnFn to *one place* (if possible)
        if (subtaskCallMeta.returnFnCalled) { return; }
        
        const res = subtaskCallMeta.returnFn.apply(null, [subtaskCallMeta.resultPtr]);
        
        _debugLog('[_asyncStartCall()] finished calling return fn', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
          res,
        });
        
        return;
      }
      
      // If there is no where to lower the results, exit early
      if (!subtaskCallMeta.resultPtr) {
        _debugLog('[_asyncStartCall()] no result ptr during subtask result handling, returning early (skipping lower)');
        return;
      }
      
      let callerMemory;
      if (callerMemoryIdx !== null && callerMemoryIdx !== undefined) {
        callerMemory = lookupMemoriesForComponent({ componentIdx: callerComponentIdx, memoryIdx: callerMemoryIdx });
      } else {
        const callerMemories = lookupMemoriesForComponent({ componentIdx: callerComponentIdx });
        if (callerMemories.length !== 1) { throw new Error(`unsupported amount of caller memories`); }
        callerMemory = callerMemories[0];
      }
      
      if (!callerMemory) {
        _debugLog('[_asyncStartCall()] missing memory', { subtaskID: subtask.id(), res });
        throw new Error(`missing memory for to guest->guest call result (subtask [${subtask.id()}])`);
      }
      
      const lowerFns = calleeTask.getReturnLowerFns();
      if (!lowerFns || lowerFns.length === 0) {
        _debugLog('[_asyncStartCall()] missing result lower metadata for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`missing result lower metadata for guest->guest call (subtask [${subtask.id()}])`);
      }
      
      if (lowerFns.length !== 1) {
        _debugLog('[_asyncStartCall()] only single result reportetd for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`only single result supported for guest->guest calls (subtask [${subtask.id()}])`);
      }
      
      _debugLog('[_asyncStartCall()] lowering results', { subtaskID: subtask.id() });
      lowerFns[0]({
        realloc: undefined,
        memory: callerMemory,
        vals: [res],
        storagePtr: subtaskCallMeta.resultPtr,
        componentIdx: callerComponentIdx,
        stringEncoding: subtaskCallMeta.stringEncoding,
      });
      
    });
    
    subtask.setOnProgressFn(() => {
      subtask.setPendingEvent(() => {
        if (subtask.isResolved()) { subtask.deliverResolve(); }
        const event = {
          code: ASYNC_EVENT_CODE.SUBTASK,
          payload0: subtask.waitableRep(),
          payload1: subtask.getStateNumber(),
        };
        return event;
      });
    });
    
    // Start the (event) driver loop that will resolve the subtask
    // in a new JS task
    setTimeout(async () => {
      _debugLog('[_asyncStartCall()] continuing started subtask (in JS task)', {
        taskID: preparedTask.id(),
        subtaskID: subtask.id(),
        callerComponentIdx,
        calleeComponentIdx,
      });
      
      let startRes = subtask.onStart({ startFnParams: params });
      startRes = Array.isArray(startRes) ? startRes : [startRes];
      
      if (calleeComponentState.isExclusivelyLocked()) {
        _debugLog('[_asyncStartCall()] during continuation callee is exclusively locked, suspending...', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
          callerComponentIdx,
          calleeComponentIdx,
        });
        await calleeComponentState.suspendTask({
          task: preparedTask,
          readyFn: () => !calleeComponentState.isExclusivelyLocked(),
        });
      }
      
      const started = await preparedTask.enter();
      if (!started) {
        _debugLog('[_asyncStartCall()] task failed early', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
        });
        throw new Error("task failed to start");
        return;
      }
      
      let callbackResult;
      try {
        let jspiCallee = WebAssembly.promising(callee);
        callbackResult = await _withGlobalCurrentTaskMetaAsync({
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          fn: () => {
            return jspiCallee.apply(null, startRes);
          }
        });
      } catch(err) {
        _debugLog("[_asyncStartCall()] initial subtask callee run failed", err);
        // NOTE: a good place to rejectt the parent task, if rejection API is enabled
        // subtask.reject(err);
        // subtask.getParentTask().reject(err);
        
        subtask.getParentTask().setErrored(err);
        
        return;
      }
      
      // If there was no callback function, we're dealing with a sync function
      // that was lifted as async without one, there is only the callee.
      if (!callbackFn) {
        _debugLog("[_asyncStartCall()] no callback, resolving w/ callee result", {
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          preparedTask,
          stateNumber: preparedTask.taskState(),
          isResolved: preparedTask.isResolved(),
          callbackFn,
        });
        preparedTask.resolve([callbackResult]);
        return;
      }
      
      let fnName = callbackFn.fnName;
      if (!fnName) {
        fnName = [
        '<task ',
        subtask.parentTaskID(),
        '/subtask ',
        subtask.id(),
        '/task ',
        preparedTask.id(),
        '>',
        ].join("");
      }
      
      try {
        _debugLog("[_asyncStartCall()] starting driver loop", {
          fnName,
          componentIdx: preparedTask.componentIdx(),
          subtaskID: subtask.id(),
          childTaskID: subtask.childTaskID(),
          parentTaskID: subtask.parentTaskID(),
        });
        
        await _driverLoop({
          componentState: calleeComponentState,
          task: preparedTask,
          fnName,
          isAsync: true,
          callbackResult,
          resolve,
          reject
        });
      } catch (err) {
        _debugLog("[AsyncStartCall] drive loop call failure", { err });
      }
      
    }, 0);
    
    const subtaskState = subtask.getStateNumber();
    if (subtaskState < 0 || subtaskState > 2**5) {
      throw new Error('invalid subtask state, out of valid range');
    }
    
    _debugLog('[_asyncStartCall()] returning subtask rep & state', {
      subtask: {
        rep: subtask.waitableRep(),
        state: subtaskState,
      }
    });
    
    return Number(subtask.waitableRep()) << 4 | subtaskState;
  }
  
  function _syncStartCall(callbackIdx) {
    _debugLog('[_syncStartCall()] args', { callbackIdx });
    throw new Error('synchronous start call not implemented!');
  }
  
  class Waitable {
    #componentIdx;
    
    #pendingEventFn = null;
    
    #promise;
    #resolve;
    #reject;
    
    #waitableSet = null;
    
    #hasSyncWaiter = false;
    
    #idx = null; // to component-global waitables
    
    target;
    
    constructor(args) {
      const { componentIdx, target } = args;
      this.#componentIdx = componentIdx;
      this.target = args.target;
      this.#resetPromise();
    }
    
    componentIdx() { return this.#componentIdx; }
    isInSet() { return this.#waitableSet !== null; }
    
    idx() { return this.#idx; }
    setIdx(idx) {
      if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
      this.#idx = idx;
    }
    
    setTarget(tgt) { this.target = tgt; }
    
    #resetPromise() {
      const { promise, resolve, reject } = promiseWithResolvers()
      this.#promise = promise;
      this.#resolve = resolve;
      this.#reject = reject;
    }
    
    resolve() { this.#resolve(); }
    reject(err) { this.#reject(err); }
    promise() { return this.#promise; }
    
    hasPendingEvent() {
      // _debugLog('[Waitable#hasPendingEvent()]', {
        //     componentIdx: this.#componentIdx,
        //     waitable: this,
        //     waitableSet: this.#waitableSet,
        //     hasPendingEvent: this.#pendingEventFn !== null,
        // });
        return this.#pendingEventFn !== null;
      }
      
      setPendingEvent(fn) {
        _debugLog('[Waitable#setPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
        });
        this.#pendingEventFn = fn;
      }
      
      getPendingEvent() {
        _debugLog('[Waitable#getPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
          hasPendingEvent: this.#pendingEventFn !== null,
        });
        if (this.#pendingEventFn === null) { return null; }
        const eventFn = this.#pendingEventFn;
        this.#pendingEventFn = null;
        const e = eventFn();
        this.#resetPromise();
        return e;
      }
      
      join(waitableSet) {
        _debugLog('[Waitable#join()] args', {
          waitable: this,
          waitableSet: waitableSet,
          isRemoval: waitableSet === null,
        });
        
        if (this.#waitableSet === undefined) {
          throw new TypeError('waitable set must be not be undefined');
        }
        
        if (this.#waitableSet) {
          this.#waitableSet.removeWaitable(this);
        }
        
        this.#waitableSet = waitableSet;
        
        if (waitableSet) {
          this.#waitableSet.addWaitable(this);
        }
      }
      
      drop() {
        _debugLog('[Waitable#drop()] args', {
          componentIdx: this.#componentIdx,
          waitable: this,
        });
        if (this.hasPendingEvent()) {
          throw new Error('waitables with pending events cannot be dropped');
        }
        this.join(null);
      }
      
      async waitForPendingEvent(args) {
        const { cstate } = args;
        if (!cstate) { throw new TypeError('missing component state'); }
        
        if (this.#waitableSet !== null || this.#hasSyncWaiter) {
          throw new Error("waitable is already in a set/has a sync waiter");
        }
        this.#hasSyncWaiter = true;
        await cstate.waitUntil({
          cancellable: false,
          readyFn: () => this.hasPendingEvent(),
        });
        this.#hasSyncWaiter = false;
      }
      
    }
    
    const ERR_CTX_TABLES = {};
    
    function contextGet(ctx) {
      const { componentIdx, slot } = ctx;
      if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
      if (slot === undefined) { throw new TypeError("missing slot"); }
      
      const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
      if (!currentTaskMeta) {
        throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context set`);
      }
      const taskID = currentTaskMeta.taskID;
      
      const taskMeta = getCurrentTask(componentIdx, taskID);
      if (!taskMeta) { throw new Error('failed to retrieve current task'); }
      
      let task = taskMeta.task;
      if (!task) { throw new Error('invalid/missing current task in metadata while getting context'); }
      
      _debugLog('[contextGet()] args', {
        slot,
        storage: task.storage,
        taskID: task.id(),
        componentIdx: task.componentIdx(),
      });
      
      if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
      
      return task.storage[slot];
    }
    
    
    function contextSet(ctx, value) {
      const { componentIdx, slot } = ctx;
      if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
      if (slot === undefined) { throw new TypeError("missing slot"); }
      if (!(_typeCheckValidI32(value))) { throw new Error('invalid value for context set (not valid i32)'); }
      
      const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
      if (!currentTaskMeta) {
        throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context set`);
      }
      const taskID = currentTaskMeta.taskID;
      
      const taskMeta = getCurrentTask(componentIdx, taskID);
      if (!taskMeta) { throw new Error('failed to retrieve current task'); }
      
      let task = taskMeta.task;
      if (!task) { throw new Error('invalid/missing current task in metadata while setting context'); }
      
      _debugLog('[contextSet()] args', {
        slot,
        value,
        storage: task.storage,
        taskID: task.id(),
        componentIdx: task.componentIdx(),
      });
      
      if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
      task.storage[slot] = value;
    }
    
    const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
    
    class AsyncTask {
      static _ID = 0n;
      
      static State = {
        INITIAL: 'initial',
        CANCELLED: 'cancelled',
        CANCEL_PENDING: 'cancel-pending',
        CANCEL_DELIVERED: 'cancel-delivered',
        RESOLVED: 'resolved',
      }
      
      static BlockResult = {
        CANCELLED: 'block.cancelled',
        NOT_CANCELLED: 'block.not-cancelled',
      }
      
      #id;
      #componentIdx;
      #state;
      #isAsync;
      #isManualAsync;
      #entryFnName = null;
      
      #onResolveHandlers = [];
      #completionPromise = null;
      #rejected = false;
      
      #exitPromise = null;
      #onExitHandlers = [];
      
      #memoryIdx = null;
      #memory = null;
      
      #callbackFn = null;
      #callbackFnName = null;
      
      #postReturnFn = null;
      
      #getCalleeParamsFn = null;
      
      #stringEncoding = null;
      
      #parentSubtask = null;
      
      #errHandling;
      
      #backpressurePromise;
      #backpressureWaiters = 0n;
      
      #returnLowerFns = null;
      
      #subtasks = [];
      
      #entered = false;
      #exited = false;
      #errored = null;
      
      cancelled = false;
      cancelRequested = false;
      alwaysTaskReturn = false;
      
      returnCalls =  0;
      storage = [0, 0];
      borrowedHandles = {};
      
      tmpRetI64HighBits = 0|0;
      
      constructor(opts) {
        this.#id = ++AsyncTask._ID;
        
        if (opts?.componentIdx === undefined) {
          throw new TypeError('missing component id during task creation');
        }
        this.#componentIdx = opts.componentIdx;
        
        this.#state = AsyncTask.State.INITIAL;
        this.#isAsync = opts?.isAsync ?? false;
        this.#isManualAsync = opts?.isManualAsync ?? false;
        this.#entryFnName = opts.entryFnName;
        
        const {
          promise: completionPromise,
          resolve: resolveCompletionPromise,
          reject: rejectCompletionPromise,
        } = promiseWithResolvers();
        this.#completionPromise = completionPromise;
        
        this.#onResolveHandlers.push((results) => {
          if (this.#errored !== null) {
            rejectCompletionPromise(this.#errored);
            return;
          } else if (this.#rejected) {
            rejectCompletionPromise(results);
            return;
          }
          resolveCompletionPromise(results);
        });
        
        const {
          promise: exitPromise,
          resolve: resolveExitPromise,
          reject: rejectExitPromise,
        } = promiseWithResolvers();
        this.#exitPromise = exitPromise;
        
        this.#onExitHandlers.push(() => {
          resolveExitPromise();
        });
        
        if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
        if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
        
        if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
        
        if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
        
        if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
        
        
        if (opts.errHandling) { this.#errHandling = opts.errHandling; }
      }
      
      taskState() { return this.#state; }
      id() { return this.#id; }
      componentIdx() { return this.#componentIdx; }
      entryFnName() { return this.#entryFnName; }
      
      completionPromise() { return this.#completionPromise; }
      exitPromise() { return this.#exitPromise; }
      
      isAsync() { return this.#isAsync; }
      isSync() { return !this.isAsync(); }
      
      getErrHandling() { return this.#errHandling; }
      
      hasCallback() { return this.#callbackFn !== null; }
      
      getReturnMemoryIdx() { return this.#memoryIdx; }
      setReturnMemoryIdx(idx) {
        if (idx === null) { return; }
        this.#memoryIdx = idx;
      }
      
      getReturnMemory() { return this.#memory; }
      setReturnMemory(m) {
        if (m === null) { return; }
        this.#memory = m;
      }
      
      setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
      getReturnLowerFns() { return this.#returnLowerFns; }
      
      setParentSubtask(subtask) {
        if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
        if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
        this.#parentSubtask = subtask;
      }
      
      getParentSubtask() { return this.#parentSubtask; }
      
      // TODO(threads): this is very inefficient, we can pass along a root task,
      // and ideally do not need this once thread support is in place
      getRootTask() {
        let currentSubtask = this.getParentSubtask();
        let task = this;
        while (currentSubtask) {
          task = currentSubtask.getParentTask();
          currentSubtask = task.getParentSubtask();
        }
        return task;
      }
      
      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }
      
      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }
      
      getCallbackFnName() {
        if (!this.#callbackFnName) { return undefined; }
        return this.#callbackFnName;
      }
      
      async runCallbackFn(...args) {
        if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
        return _withGlobalCurrentTaskMetaAsync({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => { return this.#callbackFn.apply(null, args); }
        });
      }
      
      getCalleeParams() {
        if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
        return this.#getCalleeParamsFn();
      }
      
      mayBlock() { return this.isAsync() || this.isResolvedState() }
      
      mayEnter(task) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (cstate.hasBackpressure()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
          return false;
        }
        if (!cstate.callingSyncImport()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
          return false;
        }
        const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
        if (!callingSyncExportWithSyncPending) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
          return false;
        }
        return true;
      }
      
      enterSync() {
        if (this.needsExclusiveLock()) {
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          // TODO(???): it is *very possible* for a the line below to fail if
          // an async function is already running (and holding the exclusive lock)
          //
          // It's not really possible to fix this unless we turn every sync export into
          // an async export that will use the regular async enabled `enter()`.
          cstate.exclusiveLock();
        }
        return true;
      }
      
      async enter(opts) {
        _debugLog('[AsyncTask#enter()] args', {
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          subtaskID: this.getParentSubtask()?.id(),
          args: opts,
          entryFnName: this.#entryFnName,
        });
        
        if (this.#entered) {
          throw new Error(`task with ID [${this.#id}] should not be entered twice`);
        }
        
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        
        if (opts?.isHost) {
          this.#entered = true;
          return this.#entered;
        }
        
        await cstate.nextTaskExecutionSlot({ task: this });
        
        // If a task is synchronous then we can avoid component-relevant
        // tracking and immediately enter.
        if (this.isSync()) {
          this.#entered = true;
          
          // TODO(breaking): remove once manually-specifying async fns is removed
          // It is currently possible for an actually sync export to be specified
          // as async via JSPI
          if (this.#isManualAsync) {
            if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
          }
          
          return this.#entered;
        }
        
        // Perform intial backpressure check
        if (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
          cstate.addBackpressureWaiter();
          
          const result = await this.waitUntil({
            readyFn: () => {
              return !(cstate.hasBackpressure()
              || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
            },
            cancellable: true,
          });
          
          cstate.removeBackpressureWaiter();
          
          if (result === AsyncTask.BlockResult.CANCELLED) {
            this.cancel();
            return false;
          }
        }
        
        // Lock the component state or keep trying until we can/do
        try {
          if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
        } catch {
          // Continuously attempt to lock until we can
          while (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
            try {
              if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
              break;
            } catch(err) {
              cstate.addBackpressureWaiter();
              const result = await this.waitUntil({
                readyFn: () => {
                  return !(cstate.hasBackpressure()
                  || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
                },
                cancellable: true,
              });
              cstate.removeBackpressureWaiter();
              if (result === AsyncTask.BlockResult.CANCELLED) {
                this.cancel();
                return false;
              }
            }
          }
        }
        
        this.#entered = true;
        return this.#entered;
      }
      
      isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
      isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
      isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
      
      async waitUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });
        
        // TODO(fix): check for cancel
        // TODO(fix): determinism
        // TODO(threads): add this thread to waiting list
        
        const keepGoing = await this.suspendUntil({
          readyFn,
          cancellable,
        });
        
        return keepGoing;
      }
      
      async yieldUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#yieldUntil()]', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const keepGoing = await this.suspendUntil({ readyFn, cancellable });
        if (keepGoing) {
          return {
            code: ASYNC_EVENT_CODE.NONE,
            payload0: 0,
            payload1: 0,
          };
        }
        
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
          payload0: 0,
          payload1: 0,
        };
      }
      
      async suspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#suspendUntil()] args', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const pendingCancelled = this.deliverPendingCancel({ cancellable });
        if (pendingCancelled) { return false; }
        
        const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
        return completed;
      }
      
      // TODO(threads): equivalent to thread.suspend_until()
      async immediateSuspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
          args: {
            cancellable,
            readyFn,
          },
          taskID: this.#id,
          componentIdx: this.#componentIdx,
        });
        
        const ready = readyFn();
        if (ready && ASYNC_DETERMINISM === 'random') {
          const coinFlip = _coinFlip();
          if (coinFlip) { return true }
        }
        
        const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
        return keepGoing;
      }
      
      async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
      // TODO(threads): store readyFn on the thread
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
      
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({ task: this, readyFn });
      return keepGoing;
    }
    
    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog('[AsyncTask#deliverPendingCancel()]', {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });
      
      if (cancellable && this.#state === AsyncTask.State.PENDING_CANCEL) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }
      
      return false;
    }
    
    isCancelled() { return this.cancelled }
    
    cancel(args) {
      _debugLog('[AsyncTask#cancel()] args', { });
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
      }
      if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
      this.cancelled = true;
      this.onResolve(args?.error ?? new Error('task cancelled'));
      this.#state = AsyncTask.State.RESOLVED;
    }
    
    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        const meta = this.#parentSubtask.getCallMetadata();
        // Run the rturn fn if it has not already been called -- this *should* have happened in
        // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
        // which goes through prepare + async-start-call)
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog('[AsyncTask#onResolve()] running returnFn', {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id(),
          });
          const memory = meta.getMemoryFn();
          meta.returnFn.apply(null, [taskValue, meta.resultPtr]);
          meta.returnFnCalled = true;
        }
      }
      
      if (this.#postReturnFn) {
        _debugLog('[AsyncTask#onResolve()] running post return ', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
        });
        try {
          this.#postReturnFn(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    isRejected() { return this.#rejected; }
    
    setErrored(err) {
      this.#errored = err;
    }
    
    reject(taskErr) {
      _debugLog('[AsyncTask#reject()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message,
      });
      
      if (this.isResolvedState() || this.#rejected) { return; }
      
      for (const subtask of this.#subtasks) {
        subtask.reject(taskErr);
      }
      
      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.PENDING_CANCEL;
      const cancelled = this.deliverPendingCancel({ cancellable: true });
      
      // TODO: do cleanup here to reset the machinery so we can run again?
      
      this.cancel({ error: taskErr });
    }
    
    resolve(results) {
      _debugLog('[AsyncTask#resolve()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
      });
      
      if (this.#state === AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }
      
      if (this.borrowedHandles.length > 0) {
        throw new Error('task still has borrow handles');
      }
      
      this.#state = AsyncTask.State.RESOLVED;
      
      switch (results.length) {
        case 0:
        this.onResolve(undefined);
        break;
        case 1:
        this.onResolve(results[0]);
        break;
        default:
        _debugLog('[AsyncTask#resolve()] unexpected number of results', {
          componentIdx: this.#componentIdx,
          results,
          taskID: this.#id,
          subtaskID: this.#parentSubtask?.id(),
          entryFnName: this.#entryFnName,
          callbackFnName: this.#callbackFnName,
        });
        throw new Error('unexpected number of results');
      }
    }
    
    exit(args) {
      _debugLog('[AsyncTask#exit()]', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });
      
      if (this.#exited)  { throw new Error("task has already exited"); }
      
      if (this.#state !== AsyncTask.State.RESOLVED) {
        // TODO(fix): only fused, manually specified post returns seem to break this invariant,
        // as the TaskReturn trampoline is not activated it seems.
        //
        // see: test/p3/ported/wasmtime/component-async/post-return.js
        //
        // We *should* be able to upgrade this to be more strict and throw at some point,
        // which may involve rewriting the upstream test to surface task return manually somehow.
        //
        //throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
        _debugLog('[AsyncTask#exit()] task exited without resolution', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
          subtask: this.getParentSubtask(),
          subtaskID: this.getParentSubtask()?.id(),
        });
        this.#state = AsyncTask.State.RESOLVED;
      }
      
      if (this.borrowedHandles > 0) {
        throw new Error('task [${this.#id}] exited without clearing borrowed handles');
      }
      
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
      
      // Exempt the host from exclusive lock check
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck) {
        if (this.needsExclusiveLock() && !state.isExclusivelyLocked()) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked`);
        }
      }
      
      state.exclusiveRelease();
      
      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }
      
      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }
    
    needsExclusiveLock() {
      return !this.#isAsync || this.hasCallback();
    }
    
    createSubtask(args) {
      _debugLog('[AsyncTask#createSubtask()] args', args);
      const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
      }
      
      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`,
      });
      
      const newSubtask = new AsyncSubtask({
        componentIdx,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable,
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
      waitable.setIdx(cstate.handles.insert(newSubtask));
      waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
      
      return newSubtask;
    }
    
    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }
    
    getSubtaskByWaitableRep(rep) {
      if (rep === undefined) { throw new TypeError('missing rep'); }
      return this.#subtasks.find(s => s.waitableRep() === rep);
    }
    
    currentSubtask() {
      _debugLog('[AsyncTask#currentSubtask()]');
      if (this.#subtasks.length === 0) { return undefined; }
      return this.#subtasks.at(-1);
    }
    
    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) { throw new Error('cannot end current subtask: no current subtask'); }
      this.#subtasks = this.#subtasks.filter(t => t !== subtask);
      return subtask;
    }
  }
  
  const ASYNC_EVENT_CODE = {
    NONE: 0,
    SUBTASK: 1,
    STREAM_READ: 2,
    STREAM_WRITE: 3,
    FUTURE_READ: 4,
    FUTURE_WRITE: 5,
    TASK_CANCELLED: 6,
  };
  
  function getCurrentTask(componentIdx, taskID) {
    let usedGlobal = false;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing component idx'); // TODO(fix)
      // componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
      // usedGlobal = true;
    }
    
    const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (taskMetas === undefined || taskMetas.length === 0) { return undefined; }
    
    if (taskID) {
      return taskMetas.find(meta => meta.task.id() === taskID);
    }
    
    const taskMeta = taskMetas[taskMetas.length - 1];
    if (!taskMeta || !taskMeta.task) { return undefined; }
    
    return taskMeta;
  }
  
  const emptyFunc = () => {};
  
  let dv = new DataView(new ArrayBuffer());
  const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);
  
  function toUint64(val) {
    const converted = BigInt(val)
    
    return BigInt.asUintN(64, converted);
  }
  
  
  function toUint16(val) {
    
    val >>>= 0;
    val %= 2 ** 16;
    return val;
  }
  
  
  function toUint32(val) {
    
    return val >>> 0;
  }
  
  
  function toUint8(val) {
    
    val >>>= 0;
    val %= 2 ** 8;
    return val;
  }
  
  const utf16Decoder = new TextDecoder('utf-16');
  const TEXT_DECODER_UTF8 = new TextDecoder();
  const TEXT_ENCODER_UTF8 = new TextEncoder();
  
  function _utf8AllocateAndEncode(s, realloc, memory) {
    if (typeof s !== 'string') {
      throw new TypeError('expected a string, received [' + typeof s + ']');
    }
    if (s.length === 0) { return { ptr: 1, len: 0 }; }
    let buf = TEXT_ENCODER_UTF8.encode(s);
    let ptr = realloc(0, 0, 1, buf.length);
    new Uint8Array(memory.buffer).set(buf, ptr);
    const res = { ptr, len: buf.length, codepoints: [...s].length };
    return res;
  }
  
  
  const T_FLAG = 1 << 30;
  
  function rscTableCreateBorrow(table, rep, scopeId) {
    if (scopeId === undefined) { throw new Error("missing scopeId"); }
    const free = table[0] & ~T_FLAG;
    if (free === 0) {
      table.push(scopeId);
      table.push(rep);
      return (table.length >> 1) - 1;
    }
    table[0] = table[free << 1];
    table[free << 1] = scopeId;
    table[(free << 1) + 1] = rep;
    return free;
  }
  
  
  function rscTableCreateOwn(table, rep) {
    const free = table[0] & ~T_FLAG;
    table._createdReps.add(rep);
    if (free === 0) {
      table.push(0);
      table.push(rep | T_FLAG);
      return (table.length >> 1) - 1;
    }
    table[0] = table[free << 1];
    table[free << 1] = 0;
    table[(free << 1) + 1] = rep | T_FLAG;
    return free;
  }
  
  function rscTableRemove(table, handle) {
    const scope = table[handle << 1];
    const val = table[(handle << 1) + 1];
    const own = (val & T_FLAG) !== 0;
    const rep = val & ~T_FLAG;
    if (val === 0 || (scope & T_FLAG) !== 0) {
      throw new TypeError("Invalid handle");
    }
    table[handle << 1] = table[0] | T_FLAG;
    table[0] = handle | T_FLAG;
    return { rep, scope, own };
  }
  
  let curResourceBorrows = [];
  
  function createNewCurrentTask(args) {
    _debugLog('[createNewCurrentTask()] args', args);
    const {
      componentIdx,
      isAsync,
      isManualAsync,
      entryFnName,
      parentSubtaskID,
      callbackFnName,
      getCallbackFn,
      getParamsFn,
      stringEncoding,
      errHandling,
      getCalleeParamsFn,
      resultPtr,
      callingWasmExport,
    } = args;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while starting task');
    }
    let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    const callbackFn = getCallbackFn ? getCallbackFn() : null;
    
    const newTask = new AsyncTask({
      componentIdx,
      isAsync,
      isManualAsync,
      entryFnName,
      callbackFn,
      callbackFnName,
      stringEncoding,
      getCalleeParamsFn,
      resultPtr,
      errHandling,
    });
    
    const newTaskID = newTask.id();
    const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
    
    // NOTE: do not track host tasks
    ASYNC_CURRENT_TASK_IDS.push(newTaskID);
    ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
    
    if (!taskMetas) {
      taskMetas = [newTaskMeta];
      ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    } else {
      taskMetas.push(newTaskMeta);
    }
    
    return [newTask, newTaskID];
  }
  
  function _lowerImportBackwardsCompat(args) {
    const params = [...arguments].slice(1);
    _debugLog('[_lowerImportBackwardsCompat()] args', { args, params });
    const {
      functionIdx,
      componentIdx,
      isAsync,
      isManualAsync,
      paramLiftFns,
      resultLowerFns,
      hasResultPointer,
      funcTypeIsAsync,
      metadata,
      memoryIdx,
      getMemoryFn,
      getReallocFn,
      importFn,
      stringEncoding,
    } = args;
    
    let meta = _getGlobalCurrentTaskMeta(componentIdx);
    let createdTask;
    
    // Some components depend on initialization logic (i.e. `_initialize` or some such
    // core wasm export) that is embedded in the component, but is not executed or wizer'd
    // away before the transpiled component is attempted to be used.
    //
    // These components execut their initialization logic *when they are imported* in the
    // transpiled context -- so we may get a call to an export that is lowered without going
    // through `CallWasm` or `CallInterface`.
    //
    if (!meta) {
      if (funcTypeIsAsync || (isAsync && !isManualAsync)) {
        throw new Error('p3 async wasm exports cannot use backwards compat auto-task init');
      }
      
      const [newTask, newTaskID] = createNewCurrentTask({
        componentIdx,
        isAsync,
        isManualAsync,
        callingWasmExport: false,
      });
      createdTask = newTask;
      
      // Since we're managing the task creation ourselves we must clear ourselves
      createdTask.registerOnResolveHandler(() => {
        _clearCurrentTask({
          taskID: task.id(),
          componentIdx: task.componentIdx(),
        });
      });
      
      _setGlobalCurrentTaskMeta({
        componentIdx,
        taskID: newTaskID,
      });
      
      meta = _getGlobalCurrentTaskMeta(componentIdx);
    }
    
    const { taskID } = meta;
    
    const taskMeta = getCurrentTask(componentIdx, taskID);
    if (!taskMeta) {
      throw new Error('invalid/missing async task meta');
    }
    
    const task = taskMeta.task;
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    // TODO: re-enable this check -- postReturn can call imports though,
    // and that breaks things.
    //
    // if (!cstate.mayLeave) {
      //     throw new Error(`cannot leave instance [${componentIdx}]`);
      // }
      
      if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
        throw new Error("non async exports cannot synchronously call async functions");
      }
      
      // If there is an existing task, this should be part of a subtask
      const memory = getMemoryFn();
      // Canonical ABI lower appends result storage as a trailing
      // param when async lower has any flat result, or sync lower
      // has more than one flat result.
      const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
      const subtask = task.createSubtask({
        componentIdx,
        parentTask: task,
        fnName: importFn.fnName,
        isAsync,
        isManualAsync,
        callMetadata: {
          memoryIdx,
          memory,
          realloc: getReallocFn?.(),
          getReallocFn,
          resultPtr,
          lowers: resultLowerFns,
          stringEncoding,
        }
      });
      task.setReturnMemoryIdx(memoryIdx);
      task.setReturnMemory(getMemoryFn());
      
      subtask.onStart();
      
      // If dealing with a sync lowered sync function, we can directly return results
      //
      // TODO(breaking): remove once we get rid of manual async import specification,
      // as func types cannot be detected in that case only (and we don't need that w/ p3)
      if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
        if (createdTask) { createdTask.enterSync(); }
        
        const res = importFn(...params);
        
        // TODO(breaking): remove once we get rid of manual async import specification,
        // as func types cannot be detected in that case only (and we don't need that w/ p3)
        if (!funcTypeIsAsync && !subtask.isReturned()) {
          throw new Error('post-execution subtasks must either be async or returned');
        }
        
        const syncRes = subtask.getResult();
        if (createdTask) { createdTask.resolve([syncRes]); }
        
        return syncRes;
      }
      
      // Sync-lowered async functions requires async behavior because the callee *can* block,
      // but this call must *act* synchronously and return immediately with the result
      // (i.e. not returning until the work is done)
      //
      // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
      //
      if (!isManualAsync && !isAsync && funcTypeIsAsync) {
        const { promise, resolve } = new Promise();
        queueMicrotask(async () => {
          if (!subtask.isResolvedState()) {
            await task.suspendUntil({ readyFn: () => task.isResolvedState() });
          }
          resolve(subtask.getResult());
        });
        return promise;
      }
      
      // NOTE: at this point we know that we are working with an async lowered import
      
      const subtaskState = subtask.getStateNumber();
      if (subtaskState < 0 || subtaskState >= 2**4) {
        throw new Error('invalid subtask state, out of valid range');
      }
      
      subtask.setOnProgressFn(() => {
        subtask.setPendingEvent(() => {
          if (subtask.isResolved()) { subtask.deliverResolve(); }
          const event = {
            code: ASYNC_EVENT_CODE.SUBTASK,
            payload0: subtask.waitableRep(),
            payload1: subtask.getStateNumber(),
          }
          return event;
        });
      });
      
      // This is a hack to maintain backwards compatibility with
      // manually-specified async imports, used in wasm exports that are
      // not actually async (but are specified as so).
      //
      // This is not normal p3 sync behavior but instead anticipating that
      // the caller that is doing manual async will be waiting for a promise that
      // resolves to the *actual* result.
      //
      // TODO(breaking): remove once manually specified async is removed
      //
      // There are a few cases:
      // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
      // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
      // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
      // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
      //
      // This hack *only* applies to 4 -- the case where an async JS host function
      // is supplied to a Wasm export which does *not* need to do any async abi
      // lifting/lowering (async ABI did not exist when JSPI integratiton was
      // initially merged to enable asynchronously returning values from the host)
      //
      const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
      let manualAsyncResult;
      if (requiresManualAsyncResult) {
        manualAsyncResult = promiseWithResolvers();
      }
      
      queueMicrotask(async () => {
        try {
          _debugLog('[_lowerImportBackwardsCompat()] calling lowered import', { importFn, params });
          if (createdTask) { await createdTask.enter(); }
          
          const asyncRes = await importFn(...params);
          if (requiresManualAsyncResult) {
            manualAsyncResult.resolve(subtask.getResult());
          }
          
          if (createdTask) { createdTask.resolve([asyncRes]); }
          
          
        } catch (err) {
          _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
          if (requiresManualAsyncResult) {
            manualAsyncResult.reject(err);
          }
          throw err;
        }
      });
      
      if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
      
      return Number(subtask.waitableRep()) << 4 | subtaskState;
    }
    
    function _liftFlatU8(ctx) {
      _debugLog('[_liftFlatU8()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 1) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u8 requires 1 byte)`);
      }
      
      val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true);
      
      ctx.storagePtr += 1;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 1; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU16(ctx) {
      _debugLog('[_liftFlatU16()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 2) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u16 requires 2 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getUint16(ctx.storagePtr, true);
      
      ctx.storagePtr += 2;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 2; }
      
      const rem = ctx.storagePtr % 2;
      if (rem !== 0) { ctx.storagePtr += (2 - rem); }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU32(ctx) {
      _debugLog('[_liftFlatU32()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i34 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
      }
      val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
      ctx.storagePtr += 4;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU64(ctx) {
      _debugLog('[_liftFlatU64()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least one single i64 argument'); }
        if (typeof ctx.params[0] !== 'bigint') { throw new Error('expected bigint'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u64 requires 8 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getBigUint64(ctx.storagePtr, true);
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatFloat64(ctx) {
      _debugLog('[_liftFlatFloat64()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) {
          throw new Error('expected at least one single f64 argument');
        }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        
        if (ctx.inVariant) {
          const dv = new DataView(new ArrayBuffer(8));
          dv.setBigInt64(0, val);
          val = dv.getFloat64(0);
        }
        
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (f64 requires 8 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getFloat64(ctx.storagePtr, true);
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatStringAny(ctx) {
      switch (ctx.stringEncoding) {
        case 'utf8':
        return _liftFlatStringUTF8(ctx);
        case 'utf16':
        return _liftFlatStringUTF16(ctx);
        default:
        throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
      }
    }
    
    function _liftFlatStringUTF8(ctx) {
      _debugLog('[_liftFlatStringUTF8()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
        let offset = ctx.params[0];
        if (typeof offset === 'bigint') { offset = Number(offset); }
        if (!Number.isSafeInteger(offset)) { throw new Error('invalid offset'); }
        const len = ctx.params[1];
        if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
        val = TEXT_DECODER_UTF8.decode(new DataView(ctx.memory.buffer, offset, len));
        ctx.params = ctx.params.slice(2);
        return [val, ctx];
      }
      
      const rem = ctx.storagePtr % 4;
      if (rem !== 0) { ctx.storagePtr += (4 - rem); }
      
      const dv = new DataView(ctx.memory.buffer);
      const start = dv.getUint32(ctx.storagePtr, true);
      const codeUnits = dv.getUint32(ctx.storagePtr + 4, true);
      
      val = TEXT_DECODER_UTF8.decode(new Uint8Array(ctx.memory.buffer, start, codeUnits));
      
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storagelen -= 8; }
      
      return [val, ctx];
    }
    
    function _liftFlatStringUTF16(ctx) {
      _debugLog('[_liftFlatStringUTF16()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
        let offset = ctx.params[0];
        if (typeof offset === 'bigint') { offset = Number(offset); }
        if (!Number.isSafeInteger(offset)) {  throw new Error('invalid offset'); }
        const len = ctx.params[1];
        if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
        val = utf16Decoder.decode(new DataView(ctx.memory.buffer, offset, len));
        ctx.params = ctx.params.slice(2);
        return [val, ctx];
      }
      
      const data = new DataView(ctx.memory.buffer)
      const start = data.getUint32(ctx.storagePtr, vals[0], true);
      const codeUnits = data.getUint32(ctx.storagePtr, vals[0] + 4, true);
      val = utf16Decoder.decode(new Uint16Array(ctx.memory.buffer, start, codeUnits));
      ctx.storagePtr = ctx.storagePtr + 2 * codeUnits;
      if (ctx.storageLen !== undefined) { ctx.storageLen = ctx.storageLen - 2 * codeUnits }
      
      return [val, ctx];
    }
    
    function _liftFlatRecord(meta) {
      const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
      return function _liftFlatRecordInner(ctx) {
        _debugLog('[_liftFlatRecord()] args', { ctx });
        
        const originalPtr = ctx.storagePtr;
        const res = {};
        for (const [key, liftFn, size32, align32] of fieldMetas) {
          let fieldPtr;
          if (ctx.storagePtr !== undefined) {
            const rem = ctx.storagePtr % align32;
            if (rem !== 0) { ctx.storagePtr += align32 - rem; }
            fieldPtr = ctx.storagePtr;
          }
          
          // A field occupies exactly size32 bytes of the record's
          // flat storage. Capture the remaining storage budget before
          // lifting the field and restore it afterwards: a field's own
          // lift fn may repurpose storageLen internally (e.g. a list
          // sets it to the element-buffer length while reading
          // out-of-line data and never restores it), which would
          // otherwise corrupt the budget the next field sees.
          // See https://github.com/bytecodealliance/jco/issues/1585.
          let fieldLen;
          if (ctx.storageLen !== undefined) { fieldLen = ctx.storageLen; }
          
          let [val, newCtx] = liftFn(ctx);
          res[key] = val;
          ctx = newCtx;
          
          if (fieldPtr !== undefined) {
            ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
          }
          if (fieldLen !== undefined) {
            ctx.storageLen = fieldLen - size32;
          }
        }
        
        if (originalPtr !== undefined) {
          ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
        }
        
        if (ctx.storagePtr !== undefined) {
          const rem = ctx.storagePtr % recordAlign32;
          if (rem !== 0) { ctx.storagePtr += recordAlign32 - rem; }
        }
        
        return [res, ctx];
      }
    }
    
    function _liftFlatVariant(meta) {
      const {
        caseMetas,
        variantSize32,
        variantAlign32,
        variantPayloadOffset32,
        variantFlatCount,
        isEnum,
      } = meta;
      
      return function _liftFlatVariantInner(ctx) {
        _debugLog('[_liftFlatVariant()] args', { ctx });
        const origUseParams = ctx.useDirectParams;
        
        // If we're in the process of lifting a variant, we note
        // we are during any lifting that happens (e.g. to accomodate f32/f64 mechanics)
        const wasInVariant = ctx.inVariant;
        ctx.inVariant = true;
        
        let caseIdx;
        let liftRes;
        const originalPtr = ctx.storagePtr;
        const numCases =  caseMetas.length;
        if (caseMetas.length < 256) {
          liftRes = _liftFlatU8(ctx);
        } else if (numCases >= 256 && numCases < 65536) {
          liftRes = _liftFlatU16(ctx);
        } else if (numCases >= 65536 && numCases < 4_294_967_296) {
          liftRes = _liftFlatU32(ctx);
        } else {
          throw new Error(`unsupported number of variant cases [${numCases}]`);
        }
        caseIdx = liftRes[0];
        ctx = liftRes[1];
        
        const [
        tag,
        liftFn,
        caseSize32,
        caseAlign32,
        caseFlatCount,
        ] = caseMetas[caseIdx];
        
        if (variantPayloadOffset32 === undefined) {
          throw new Error('unexpectedly missing payload offset');
        }
        
        if (originalPtr !== undefined) {
          ctx.storagePtr = originalPtr + variantPayloadOffset32;
        }
        
        let val;
        if (liftFn === null) {
          val = { tag };
          // NOTE: here we need to move past the entire object in memory
          // despite moving to the payload which we now know is missing/unnecessary
          if (originalPtr !== undefined) {
            ctx.storagePtr = originalPtr + variantSize32;
          }
        } else {
          if (ctx.useDirectParams && ctx.params && liftFn !== _liftFlatFloat64 && typeof ctx.params[0] === 'bigint') {
            if (ctx.params[0] > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new Error(`invalid value, reinterpreted i32/f32 too large: [${ctx.params[0]}]`);
            }
            ctx.params[0] = Number(ctx.params[0]);
          }
          
          const [newVal, newCtx] = liftFn(ctx);
          val = { tag, val: newVal };
          ctx = newCtx;
        }
        
        if (origUseParams) {
          if (variantFlatCount === undefined || variantFlatCount === null) {
            _debugLog('[_liftFlatVariant()] variant with unknown flat count', { ctx, meta });
            throw new Error('cannot lift variant with unknown flat count');
          }
          if (caseFlatCount === undefined || caseFlatCount === null) {
            _debugLog('[_liftFlatVariant()] case with unknown flat count', { ctx, meta, case: meta.caseMetas[caseIdx] });
            throw new Error('cannot lift case with unknown flat count');
          }
          // NOTE: enums can be tightly packed and do not have a descriminant
          const remainingPayloadParams = variantFlatCount - caseFlatCount - (isEnum ? 0 : 1);
          if (remainingPayloadParams < 0) {
            throw new Error(`invalid variant flat count metadata`);
          }
          if (ctx.params.length < remainingPayloadParams) {
            throw new Error(`expected at least [${remainingPayloadParams}] remaining variant payload params, but got [${ctx.params.length}]`);
          }
          ctx.params = ctx.params.slice(remainingPayloadParams);
        }
        
        if (ctx.storagePtr !== undefined) {
          const rem = ctx.storagePtr % variantAlign32;
          if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
        }
        
        ctx.inVariant = wasInVariant;
        
        return [val, ctx];
      }
    }
    
    function _liftFlatList(meta) {
      const { elemLiftFn, elemSize32, elemAlign32, knownLen, typedArray } = meta;
      
      const listValue =
      typedArray === undefined
      ? values => values
      : values => new typedArray(values);
      
      const readValuesAndReset = (ctx, originalPtr, originalLen, dataPtr, len) => {
        ctx.storagePtr = dataPtr;
        const val = [];
        for (var i = 0; i < len; i++) {
          const elemPtr = dataPtr + i * elemSize32;
          ctx.storagePtr = elemPtr;
          const [res, nextCtx] = elemLiftFn(ctx);
          val.push(res);
          ctx = nextCtx;
          
          ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
        }
        if (originalPtr !== null) { ctx.storagePtr = originalPtr; }
        if (originalLen !== null) { ctx.storageLen = originalLen; }
        return [listValue(val), ctx];
      };
      
      return function _liftFlatListInner(ctx) {
        _debugLog('[_liftFlatList()] args', { ctx });
        
        let liftResults;
        if (knownLen !== undefined) { // list with known length
        if (ctx.useDirectParams) {
          _debugLog('memory unexpectedly missing while lifting unknown length list', { ctx });
          liftResults = [listValue(ctx.params.slice(0, knownLen)), ctx];
          ctx.params = ctx.params.slice(knownLen);
        } else { // indirect params
        if (ctx.memory === null) {
          _debugLog('memory unexpectedly missing while lifting known length list', { knownLen, ctx });
          throw new Error(`memory missing while lifting known length (${knownLen}) list`);
        }
        
        const originalLen = ctx.storageLen;
        const originalPtr = ctx.storagePtr;
        
        ctx.storageLen = knownLen * elemSize32;
        liftResults = readValuesAndReset(ctx, null, originalLen, ctx.storagePtr, knownLen);
      }
      
    } else { // unknown length list
    
    if (ctx.useDirectParams) {
      // unknown length list ptr w/ direct params
      const dataPtr = ctx.params[0];
      const len = ctx.params[1];
      ctx.params = ctx.params.slice(2);
      
      ctx.useDirectParams = false;
      const originalPtr = ctx.storagePtr;
      const originalLen = ctx.storageLen;
      ctx.storageLen = len * elemSize32;
      
      liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
      
      ctx.useDirectParams = true;
    } else {
      // unknown length list ptr w/ in-memory params
      const originalLen = ctx.storageLen;
      ctx.storageLen = 8;
      
      const dataPtrLiftRes = _liftFlatU32(ctx);
      const dataPtr = dataPtrLiftRes[0];
      ctx = dataPtrLiftRes[1];
      
      const lenLiftRes = _liftFlatU32(ctx);
      const len = lenLiftRes[0];
      ctx = lenLiftRes[1];
      
      const originalPtr = ctx.storagePtr;
      ctx.storagePtr = dataPtr;
      
      ctx.storageLen = len * elemSize32;
      liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
    }
  }
  
  return liftResults;
}
}

function _liftFlatTuple(meta) {
  const { elemLiftFns, size32: tupleSize32, align32: tupleAlign32 } = meta;
  return function _liftFlatTupleInner(ctx) {
    _debugLog('[_liftFlatTuple()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const val = [];
    for (const [ liftFn, size32, align32 ]  of elemLiftFns) {
      let elemPtr;
      if (ctx.storagePtr !== undefined) {
        const rem = ctx.storagePtr % align32;
        if (rem !== 0) { ctx.storagePtr += align32 - rem; }
        elemPtr = ctx.storagePtr;
      }
      
      // As in _liftFlatRecord: an element occupies exactly size32
      // bytes of the tuple's flat storage, so capture and restore
      // the storage budget around the element lift to stop a
      // field's internal storageLen use (e.g. lists) leaking into
      // the next element.
      // See https://github.com/bytecodealliance/jco/issues/1585.
      let elemLen;
      if (ctx.storageLen !== undefined) { elemLen = ctx.storageLen; }
      
      const [newValue, newCtx] = liftFn(ctx);
      val.push(newValue);
      ctx = newCtx;
      
      if (elemPtr !== undefined) {
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
      }
      if (elemLen !== undefined) {
        ctx.storageLen = elemLen - size32;
      }
    }
    
    if (originalPtr !== undefined) {
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
    }
    
    if (ctx.storagePtr !== undefined) {
      const rem = ctx.storagePtr % tupleAlign32;
      if (rem !== 0) { ctx.storagePtr += tupleAlign32 - rem; }
    }
    
    return [val, ctx];
  }
}

function _liftFlatEnum(meta) {
  meta.isEnum = true;
  const f = _liftFlatVariant(meta);
  return function _liftFlatEnumInner(ctx) {
    _debugLog('[_liftFlatEnum()] args', { ctx });
    const res = f(ctx);
    res[0] = res[0].tag;
    return res;
  }
}

function _liftFlatResult(meta) {
  const f = _liftFlatVariant(meta);
  return function _liftFlatResultInner(ctx) {
    _debugLog('[_liftFlatResult()] args', { ctx });
    return f(ctx);
  }
}

function _liftFlatOwn(meta) {
  const { className, createResourceFn, componentIdx } = meta;
  
  return function _liftFlatOwnInner(ctx) {
    _debugLog('[_liftFlatOwn()] args', { ctx, className });
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error('invalid component for resource lift');
    }
    
    const [handle, newCtx] = _liftFlatU32(ctx);
    const resource = createResourceFn(handle);
    
    return [resource, newCtx];
  }
}

function _liftFlatBorrow(componentTableIdx, size, memory, vals, storagePtr, storageLen) {
  _debugLog('[_liftFlatBorrow()] args', { size, memory, vals, storagePtr, storageLen });
  throw new Error('flat lift for borrowed resources is not supported!');
}


function _lowerFlatBool(ctx) {
  _debugLog('[_lowerFlatBool()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('bool', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU8(ctx) {
  _debugLog('[_lowerFlatU8()] args', ctx);
  
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('u8', ctx.vals[0]);
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU16(ctx) {
  _debugLog('[_lowerFlatU16()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  const rem = ctx.storagePtr % 2;
  if (rem !== 0) { ctx.storagePtr += (2 - rem); }
  
  _requireValidNumericPrimitive.bind('u16', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint16(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 2;
}

function _lowerFlatU32(ctx) {
  _debugLog('[_lowerFlatU32()] args', { ctx });
  
  if (ctx.vals.length !== 1) {
    throw new Error(`expected single value to lower, got [${ctx.vals.length}]`);
  }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  _requireValidNumericPrimitive.bind('u32', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 4;
}

function _lowerFlatU64(ctx) {
  _debugLog('[_lowerFlatU64()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 8;
  if (rem !== 0) { ctx.storagePtr += (8 - rem); }
  
  _requireValidNumericPrimitive.bind('u64', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setBigUint64(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatFloat32(ctx) {
  _debugLog('[_lowerFlatFloat32()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  _requireValidNumericPrimitive.bind('f32', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setFloat32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 4;
}

function _lowerFlatFloat64(ctx) {
  _debugLog('[_lowerFlatFloat64()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 8;
  if (rem !== 0) { ctx.storagePtr += (8 - rem); }
  
  _requireValidNumericPrimitive.bind('f64', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setFloat64(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringAny(ctx) {
  switch (ctx.stringEncoding) {
    case 'utf8':
    return _lowerFlatStringUTF8(ctx);
    case 'utf16':
    return _lowerFlatStringUTF16(ctx);
    default:
    throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
  }
}

function _lowerFlatStringUTF8(ctx) {
  _debugLog('[_lowerFlatStringUTF8()] args', ctx);
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const s = ctx.vals[0];
  const { ptr, codepoints } = _utf8AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, codepoints, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF16(ctx) {
  _debugLog('[_lowerFlatStringUTF16()] args', { ctx });
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const s = ctx.vals[0];
  const { ptr, len, codepoints } = _utf16AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, codepoints, true);
  
  const bytes = new Uint16Array(ctx.memory.buffer, start, codeUnits);
  if (ctx.memory.buffer.byteLength < start + bytes.byteLength) {
    throw new Error('memory out of bounds');
  }
  if (ctx.storageLen !== undefined && ctx.storageLen !== bytes.byteLength) {
    throw new Error(`storage length [${ctx.storageLen}] != [${bytes.byteLength}])`);
  }
  new Uint16Array(ctx.memory.buffer, ctx.storagePtr).set(bytes);
  
  ctx.storagePtr += len;
}

function _lowerFlatRecord(meta) {
  const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
  return function _lowerFlatRecordInner(ctx) {
    _debugLog('[_lowerFlatRecord()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const r = ctx.vals[0];
    for (const [tag, lowerFn, size32, align32 ] of fieldMetas) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const fieldPtr = ctx.storagePtr;
      ctx.vals = [r[tag]];
      lowerFn(ctx);
      
      ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
    
    const rem = ctx.storagePtr % recordAlign32;
    if (rem !== 0) {
      ctx.storagePtr += recordAlign32 - rem;
    }
  }
}

function _lowerFlatVariant(meta) {
  const { variantSize32, variantAlign32, variantPayloadOffset32, caseMetas } = meta;
  
  let caseLookup = {};
  for (const [idx, meta] of caseMetas.entries()) {
    let tag = meta[0];
    caseLookup[tag] = { discriminant: idx, meta };
  }
  
  return function _lowerFlatVariantInner(ctx) {
    _debugLog('[_lowerFlatVariant()] args', { ctx });
    
    const { tag, val } = ctx.vals[0];
    const variantCase = caseLookup[tag];
    if (!variantCase) {
      throw new Error(`missing tag [${tag}] (valid tags: ${Object.keys(caseLookup)})`);
    }
    
    const [ _tag, lowerFn, caseSize32, caseAlign32, caseFlatCount ] = variantCase.meta;
    
    const originalPtr = ctx.storagePtr;
    ctx.vals = [variantCase.discriminant];
    let discLowerRes;
    if (caseMetas.length < 256) {
      discLowerRes = _lowerFlatU8(ctx);
    } else if (caseMetas.length >= 256 && caseMetas.length < 65536) {
      discLowerRes = _lowerFlatU16(ctx);
    } else if (caseMetas.length >= 65536 && caseMetas.length < 4_294_967_296) {
      discLowerRes = _lowerFlatU32(ctx);
    } else {
      throw new Error(`unsupported number of cases [${caseMetas.length}]`);
    }
    
    const payloadOffsetPtr = originalPtr + variantPayloadOffset32;
    ctx.storagePtr = payloadOffsetPtr;
    ctx.vals = [val];
    if (lowerFn) { lowerFn(ctx); }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + variantSize32);
    
    const rem = ctx.storagePtr % variantAlign32;
    if (rem !== 0) { ctx.storagePtr += varianttAlign32 - rem; }
  }
}

function _lowerFlatList(meta) {
  const {
    elemLowerFn,
    knownLen,
    size32,
    align32,
    elemSize32,
    elemAlign32,
  } = meta;
  
  if (!elemLowerFn) { throw new TypeError("missing/invalid element lower fn for list"); }
  
  return function _lowerFlatListInner(ctx) {
    _debugLog('[_lowerFlatList()] args', { ctx });
    
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) { throw new Error('insufficient params left to lower list'); }
      const storagePtr = ctx.params[0];
      const elemCount = ctx.params[1];
      ctx.params = ctx.params.slice(2);
      
      const list = ctx.vals[0];
      if (!list) { throw new Error("missing direct param value"); }
      
      const lowerCtx = {
        storagePtr,
        memory: ctx.memory,
        stringEncoding: ctx.stringEncoding,
      };
      for (let idx = 0; idx < list.length; idx++) {
        const elemPtr = storagePtr + idx * elemSize32;
        lowerCtx.storagePtr = elemPtr;
        lowerCtx.vals = list.slice(idx, idx+1);
        elemLowerFn(lowerCtx);
        lowerCtx.storagePtr = Math.max(lowerCtx.storagePtr, elemPtr + elemSize32);
      }
      ctx.storagePtr = lowerCtx.storagePtr;
      
      // TODO: implement parma-only known-length processing
      
      return;
    }
    
    // TODO(fix): is it possible to get a vals that are a addr and length here from
    // a component lower?
    
    const elems = ctx.vals[0];
    if (knownLen === undefined) {
      // unknown length
      if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
      const dataPtr = ctx.realloc(0, 0, elemAlign32, elemSize32 * elems.length);
      
      ctx.vals[0] = dataPtr;
      _lowerFlatU32(ctx);
      
      ctx.vals[0] = elems.length;
      _lowerFlatU32(ctx);
      
      const origPtr = ctx.storagePtr;
      ctx.storagePtr = dataPtr;
      
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = dataPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
      
      ctx.storagePtr = origPtr;
      
    } else {
      // known length
      
      if (elems.length !== knownLen) {
        throw new TypeError(`invalid list input of length [${elems.length}], must be length [${knownLen}]`);
      }
      
      const originalPtr = ctx.storagePtr;
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = originalPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
    }
    
    // TODO(fix): special case for u8/u16/etc, we can do a direct copy
    
    const totalSizeBytes = elems.length * size32;
    if (ctx.storageLen !== undefined && totalSizeBytes > ctx.storageLen) {
      throw new Error('not enough storage remaining for list flat lower');
    }
  }
}

function _lowerFlatTuple(meta) {
  const { elemLowerMetas, size32: tupleSize32, align32: tupleAlign32 } = meta;
  return function _lowerFlatTupleInner(ctx) {
    _debugLog('[_lowerFlatTuple()] args', { ctx });
    const originalPtr = ctx.storagePtr;
    const tuple = ctx.vals[0];
    for (const [idx, [ lowerFn, size32, align32 ]]  of elemLowerMetas.entries()) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const elemPtr = ctx.storagePtr;
      ctx.vals = [tuple[idx]];
      lowerFn(ctx);
      ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
    
    const rem = ctx.storagePtr % tupleAlign32;
    if (rem !== 0) {
      ctx.storagePtr += tupleAlign32 - rem;
    }
  }
}

function _lowerFlatEnum(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatEnumInner(ctx) {
    _debugLog('[_lowerFlatEnum()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotEnumObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v);
    if (isNotEnumObject) {
      ctx.vals[0] = { tag: v };
    }
    
    f(ctx);
  }
}

function _lowerFlatOption(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatOptionInner(ctx) {
    _debugLog('[_lowerFlatOption()] args', { ctx });
    
    const v = ctx.vals[0];
    if (v === null) {
      ctx.vals[0] = { tag: 'none' };
    } else {
      const isNotOptionObject = typeof v !== 'object'
      || Object.keys(v).length !== 2
      || !('tag' in v)
      || !(v.tag === 'some' || v.tag === 'none')
      || !('val' in v);
      if (isNotOptionObject) {
        ctx.vals[0] = { tag: 'some', val: v };
      }
    }
    
    f(ctx);
  }
}

function _lowerFlatResult(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatResultInner(ctx) {
    _debugLog('[_lowerFlatResult()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotResultObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v)
    || !('ok' === v.tag || 'err' === v.tag)
    || !('val' in v);
    if (isNotResultObject) {
      ctx.vals[0] = { tag: 'ok', val: v };
    }
    
    f(ctx);
  };
}

function _lowerFlatOwn(meta) {
  const { lowerFn, componentIdx } = meta;
  
  return function _lowerFlatOwnInner(ctx) {
    _debugLog('[_lowerFlatOwn()] args', { ctx });
    const { createFn } = ctx;
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error(`component index mismatch (expected [${componentIdx}], lift called from [${ctx.componentIdx}])`);
    }
    
    const obj = ctx.vals[0];
    if (obj === undefined || obj === null) { throw new Error('missing resource'); }
    const handle = lowerFn(obj);
    
    ctx.vals[0] = handle;
    _lowerFlatU32(ctx);
  };
}

const STREAMS = new RepTable({ target: 'global stream map' });
const ASYNC_STATE = new Map();

function getOrCreateAsyncState(componentIdx, init) {
  if (!ASYNC_STATE.has(componentIdx)) {
    const newState = new ComponentAsyncState({ componentIdx });
    ASYNC_STATE.set(componentIdx, newState);
  }
  return ASYNC_STATE.get(componentIdx);
}

class ComponentAsyncState {
  static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
  
  #componentIdx;
  #callingAsyncImport = false;
  #syncImportWait = promiseWithResolvers();
  #locked = false;
  #parkedTasks = new Map();
  #suspendedTasksByTaskID = new Map();
  #suspendedTaskIDs = [];
  #errored = null;
  
  #backpressure = 0;
  #backpressureWaiters = 0n;
  
  #handlerMap = new Map();
  #nextHandlerID = 0n;
  
  #tickLoop = null;
  #tickLoopInterval = null;
  
  #onExclusiveReleaseHandlers = [];
  
  mayLeave = true;
  
  handles;
  subtasks;
  
  constructor(args) {
    this.#componentIdx = args.componentIdx;
    this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
    this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
  };
  
  componentIdx() { return this.#componentIdx; }
  
  errored() { return this.#errored !== null; }
  setErrored(err) {
    _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
    if (this.#errored) { return; }
    if (!err) {
      err = new Error('error elswehere (see other component instance error)')
      err.componentIdx = this.#componentIdx;
    }
    this.#errored = err;
  }
  
  callingSyncImport(val) {
    if (val === undefined) { return this.#callingAsyncImport; }
    if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
    const prev = this.#callingAsyncImport;
    this.#callingAsyncImport = val;
    if (prev === true && this.#callingAsyncImport === false) {
      this.#notifySyncImportEnd();
    }
  }
  
  #notifySyncImportEnd() {
    const existing = this.#syncImportWait;
    this.#syncImportWait = promiseWithResolvers();
    existing.resolve();
  }
  
  async waitForSyncImportCallEnd() {
    await this.#syncImportWait.promise;
  }
  
  setBackpressure(v) {
    this.#backpressure = v;
    return this.#backpressure
  }
  getBackpressure() { return this.#backpressure; }
  
  incrementBackpressure() {
    const current = this.#backpressure;
    if (current < 0 || current > 2**16) {
      throw new Error(`invalid current backpressure value [${current}]`);
    }
    const newValue = this.getBackpressure() + 1;
    if (newValue >= 2**16) {
      throw new Error(`invalid new backpressure value [${newValue}], overflow`);
    }
    return this.setBackpressure(newValue);
  }
  
  decrementBackpressure() {
    const current = this.#backpressure;
    if (current < 0 || current > 2**16) {
      throw new Error(`invalid current backpressure value [${current}]`);
    }
    const newValue = Math.max(0, current - 1);
    if (newValue < 0) {
      throw new Error(`invalid new backpressure value [${newValue}], underflow`);
    }
    return this.setBackpressure(newValue);
  }
  hasBackpressure() { return this.#backpressure > 0; }
  
  waitForBackpressure() {
    let backpressureCleared = false;
    const cstate = this;
    cstate.addBackpressureWaiter();
    const handlerID = this.registerHandler({
      event: 'backpressure-change',
      fn: (bp) => {
        if (bp === 0) {
          cstate.removeHandler(handlerID);
          backpressureCleared = true;
        }
      }
    });
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (backpressureCleared) { return; }
        clearInterval(interval);
        cstate.removeBackpressureWaiter();
        resolve(null);
      }, 0);
    });
  }
  
  registerHandler(args) {
    const { event, fn } = args;
    if (!event) { throw new Error("missing handler event"); }
    if (!fn) { throw new Error("missing handler fn"); }
    
    if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
      throw new Error(`unrecognized event handler [${event}]`);
    }
    
    const handlerID = this.#nextHandlerID++;
    let handlers = this.#handlerMap.get(event);
    if (!handlers) {
      handlers = [];
      this.#handlerMap.set(event, handlers)
    }
    
    handlers.push({ id: handlerID, fn, event });
    return handlerID;
  }
  
  removeHandler(args) {
    const { event, handlerID } = args;
    const registeredHandlers = this.#handlerMap.get(event);
    if (!registeredHandlers) { return; }
    const found = registeredHandlers.find(h => h.id === handlerID);
    if (!found) { return; }
    this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
  }
  
  getBackpressureWaiters() { return this.#backpressureWaiters; }
  addBackpressureWaiter() { this.#backpressureWaiters++; }
  removeBackpressureWaiter() {
    this.#backpressureWaiters--;
    if (this.#backpressureWaiters < 0) {
      throw new Error("unexepctedly negative number of backpressure waiters");
    }
  }
  
  isExclusivelyLocked() { return this.#locked === true; }
  setLocked(locked) {
    this.#locked = locked;
  }
  
  exclusiveLock() {
    _debugLog('[ComponentAsyncState#exclusiveLock()]', {
      locked: this.#locked,
      componentIdx: this.#componentIdx,
    });
    this.setLocked(true);
  }
  
  exclusiveRelease() {
    _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
      locked: this.#locked,
      componentIdx: this.#componentIdx,
    });
    this.setLocked(false);
    
    this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
    for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
      try {
        this.#onExclusiveReleaseHandlers[idx] = null;
        f();
      } catch (err) {
        _debugLog("error while executing handler for next exclusive release", err);
        throw err;
      }
    }
  }
  
  onNextExclusiveRelease(fn) {
    _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
    this.#onExclusiveReleaseHandlers.push(fn);
  }
  
  // nextTaskPromise & nextTaskQueue are used to await current task completion and queues
  // any tasks attempting to enter() and complete.
  //
  // see: nextTaskExecutionSlot()
  //
  // TODO(threads): this should be unnecessary once threads are properly implemented,
  // as the task.enter() logic should suffice (it should be guaranteed that we cannot re-enter
  // unless the task in question is the current task in the thread execution, and only one can
  // run at a time)
  #nextTaskPromise = Promise.resolve(true);
  #nextTaskQueue = [];
  
  async nextTaskExecutionSlot(args) {
    const { task } = args;
    
    const placeholder = {
      completed: false,
      task,
      promise: task.exitPromise().then(() => {
        placeholder.completed = true;
      }),
    };
    this.#nextTaskQueue.push(placeholder);
    
    let next;
    while (true) {
      await this.#nextTaskPromise;
      
      next = this.#nextTaskQueue.find(placeholder => !placeholder.completed);
      
      // This task is next in the queue, we can continue
      if (next === undefined || next === placeholder) {
        this.#nextTaskPromise = next.promise;
        if (this.#nextTaskQueue.length > 1000) {
          this.#nextTaskQueue = this.#nextTaskQueue.filter(p => !p.completed);
          if (this.#nextTaskQueue.length > 1000) {
            _debugLog('[ComponentAsyncState#()nextTaskExecutionSlot] next task queue length > 1000 even after cleanup, tasks may be leaking');
          }
        }
        break;
      }
      
      // If we get here, this task was *not* next in the queue, continue waiting
      // (at this point the task that *is* next will likely have already set itself
      // as this.#nextTaskPromise)
    }
  }
  
  #getSuspendedTaskMeta(taskID) {
    return this.#suspendedTasksByTaskID.get(taskID);
  }
  
  #removeSuspendedTaskMeta(taskID) {
    _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
      taskID,
      componentIdx: this.#componentIdx,
    });
    const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
    const meta = this.#suspendedTasksByTaskID.get(taskID);
    this.#suspendedTaskIDs[idx] = null;
    this.#suspendedTasksByTaskID.delete(taskID);
    return meta;
  }
  
  #addSuspendedTaskMeta(meta) {
    if (!meta) { throw new Error('missing task meta'); }
    const taskID = meta.taskID;
    this.#suspendedTasksByTaskID.set(taskID, meta);
    this.#suspendedTaskIDs.push(taskID);
    if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
      this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
    }
  }
  
  // TODO(threads): readyFn is normally on the thread
  suspendTask(args) {
    const { task, readyFn } = args;
    const taskID = task.id();
    const componentIdx = task.componentIdx();
    _debugLog('[ComponentAsyncState#suspendTask()]', {
      taskID,
      componentIdx: this.#componentIdx,
      taskEntryFnName: task.entryFnName(),
      subtask: task.getParentSubtask(),
    });
    
    if (componentIdx !== this.#componentIdx) {
      throw new Error('assert: task component idx should match async state');
    }
    
    if (this.#getSuspendedTaskMeta(taskID)) {
      throw new Error(`task [${taskID}] already suspended`);
    }
    
    const { promise, resolve, reject } = promiseWithResolvers();
    this.#addSuspendedTaskMeta({
      task,
      taskID,
      readyFn,
      resume: () => {
        _debugLog('[ComponentAsyncState] resuming suspended task', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        // TODO(threads): it's thread cancellation we should be checking for below, not task
        resolve(!task.isCancelled());
      },
    });
    
    this.runTickLoop();
    
    return promise;
  }
  
  resumeTaskByID(taskID) {
    const meta = this.#removeSuspendedTaskMeta(taskID);
    if (!meta) { return; }
    if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
    meta.resume();
  }
  
  async runTickLoop() {
    if (this.#tickLoop !== null) { return; }
    this.#tickLoop = 1;
    setTimeout(async () => {
      let done = this.tick();
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        done = this.tick();
      }
      this.#tickLoop = null;
    }, 10);
  }
  
  tick() {
    // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
    
    const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
    for (const taskID of resumableTasks) {
      const meta = this.#suspendedTasksByTaskID.get(taskID);
      if (!meta || !meta.readyFn) {
        throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
      }
      
      // If the task failed via any means, allow the task to resume because
      // it's been cancelled -- the callback should immediately exit as well
      if (meta.task.isRejected()) {
        _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
        this.resumeTaskByID(taskID);
        return;
      }
      
      const isReady = meta.readyFn();
      if (!isReady) { continue; }
      
      _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
        taskID,
        componentIdx: this.#componentIdx,
      });
      this.resumeTaskByID(taskID);
    }
    
    return this.#suspendedTaskIDs.filter(t => t !== null).length === 0;
  }
  
  addStreamEndToTable(args) {
    _debugLog('[ComponentAsyncState#addStreamEnd()] args', args);
    const { tableIdx, streamEnd } = args;
    if (typeof streamEnd === 'number') { throw new Error("INSERTING BAD STREAMEND"); }
    
    let { table, componentIdx } = STREAM_TABLES[tableIdx];
    if (componentIdx === undefined || !table) {
      throw new Error(`invalid global stream table state for table [${tableIdx}]`);
    }
    
    const handle = table.insert(streamEnd);
    streamEnd.setHandle(handle);
    streamEnd.setStreamTableIdx(tableIdx);
    
    const cstate = getOrCreateAsyncState(componentIdx);
    const waitableIdx = cstate.handles.insert(streamEnd);
    streamEnd.setWaitableIdx(waitableIdx);
    
    _debugLog('[ComponentAsyncState#addStreamEnd()] added stream end', {
      tableIdx,
      table,
      handle,
      streamEnd,
      destComponentIdx: componentIdx,
    });
    
    return { handle, waitableIdx };
  }
  
  createWaitable(args) {
    return new Waitable({ target: args?.target, });
  }
  
  createReadableStreamEnd(args) {
    _debugLog('[ComponentAsyncState#createStreamEnd()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    
    const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
    if (!localStreamTable) {
      throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating stream');
    }
    
    const waitable = this.createWaitable();
    const streamEnd = new StreamReadableEnd({
      tableIdx,
      elemMeta,
      hostInjectFn,
      pendingBufferMeta: {},
      target: `stream read end (lowered, @init)`,
      waitable,
    });
    
    streamEnd.setWaitableIdx(this.handles.insert(streamEnd));
    streamEnd.setHandle(localStreamTable.insert(streamEnd));
    if (streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error("unexpectedly mismatched stream table");
    }
    const streamEndWaitableIdx = streamEnd.waitableIdx();
    const streamEndHandle = streamEnd.handle();
    waitable.setTarget(`waitable for stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
    streamEnd.setTarget(`stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
    
    return {
      waitableIdx: streamEndWaitableIdx,
      handle: streamEndHandle,
      streamEnd,
    };
  }
  
  createStream(args) {
    _debugLog('[ComponentAsyncState#createStream()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding stream"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding stream"); }
    
    const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
    if (!localStreamTable) {
      throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating stream');
    }
    
    const readWaitable = this.createWaitable();
    const writeWaitable = this.createWaitable();
    
    const stream = new InternalStream({
      tableIdx,
      elemMeta,
      readWaitable,
      writeWaitable,
      hostInjectFn,
    });
    stream.setGlobalStreamMapRep(STREAMS.insert(stream));
    
    const writeEnd = stream.writeEnd();
    writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
    writeEnd.setHandle(localStreamTable.insert(writeEnd));
    if (writeEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const writeEndWaitableIdx = writeEnd.waitableIdx();
    const writeEndHandle = writeEnd.handle();
    writeWaitable.setTarget(`waitable for stream write end (waitable [${writeEndWaitableIdx}])`);
    writeEnd.setTarget(`stream write end (waitable [${writeEndWaitableIdx}])`);
    
    const readEnd = stream.readEnd();
    readEnd.setWaitableIdx(this.handles.insert(readEnd));
    readEnd.setHandle(localStreamTable.insert(readEnd));
    if (readEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const readEndWaitableIdx = readEnd.waitableIdx();
    const readEndHandle = readEnd.handle();
    readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
    readEnd.setTarget(`stream read end (waitable [${readEndWaitableIdx}])`);
    
    return {
      writeEnd,
      writeEndWaitableIdx,
      writeEndHandle,
      readEndWaitableIdx,
      readEndHandle,
      readEnd,
    };
  }
  
  getStreamEnd(args) {
    _debugLog('[ComponentAsyncState#getStreamEnd()] args', args);
    const { tableIdx, streamEndHandle, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) {
      throw new Error('missing table idx while getting stream end');
    }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    let streamEnd;
    if (streamEndWaitableIdx !== undefined) {
      streamEnd = cstate.handles.get(streamEndWaitableIdx);
    } else if (streamEndHandle !== undefined) {
      if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting stream end`); }
      streamEnd = table.get(streamEndHandle);
    } else {
      throw new TypeError("must specify either waitable idx or handle to retrieve stream");
    }
    
    if (!streamEnd) {
      throw new Error(`missing stream end (tableIdx [${tableIdx}], handle [${streamEndHandle}], waitableIdx [${streamEndWaitableIdx}])`);
    }
    if (tableIdx && streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    return streamEnd;
  }
  
  deleteStreamEnd(args) {
    _debugLog('[ComponentAsyncState#deleteStreamEnd()] args', args);
    const { tableIdx, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamEndWaitableIdx === undefined) { throw new Error("missing stream idx while removing stream end"); }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const streamEnd = cstate.handles.get(streamEndWaitableIdx);
    if (!streamEnd) {
      throw new Error(`missing stream end [${streamEndWaitableIdx}] in component handles while deleting stream`);
    }
    if (streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    let removed = cstate.handles.remove(streamEnd.waitableIdx());
    if (!removed) {
      throw new Error(`failed to remove stream end [${streamEndWaitableIdx}] waitable obj in component [${componentIdx}]`);
    }
    
    removed = table.remove(streamEnd.handle());
    if (!removed) {
      throw new Error(`failed to remove stream end with handle [${streamEnd.handle()}] from stream table [${tableIdx}] in component [${componentIdx}]`);
    }
    
    return streamEnd;
  }
  
  removeStreamEndFromTable(args) {
    _debugLog('[ComponentAsyncState#removeStreamEndFromTable()] args', args);
    
    const { tableIdx, streamWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamWaitableIdx === undefined) {
      throw new Error("missing stream end waitable idx while removing stream end");
    }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing stream end`); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const streamEnd = cstate.handles.get(streamWaitableIdx);
    if (!streamEnd) {
      throw new Error(`missing stream end (handle [${streamWaitableIdx}], table [${tableIdx}])`);
    }
    const handle = streamEnd.handle();
    
    let removed = cstate.handles.remove(streamWaitableIdx);
    if (!removed) {
      throw new Error(`failed to remove streamEnd from handles (waitable idx [${streamWaitableIdx}]), component [${componentIdx}])`);
    }
    
    removed = table.remove(handle);
    if (!removed) {
      throw new Error(`failed to remove streamEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
    }
    
    return streamEnd;
  }
  
  createFuture(args) {
    _debugLog('[ComponentAsyncState#createFuture()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding future"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding future"); }
    
    const { table: futureTable, componentIdx } = FUTURE_TABLES[tableIdx];
    if (!futureTable) {
      throw new Error(`missing global future table lookup for table [${tableIdx}] while creating future`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating future');
    }
    
    const readWaitable = this.createWaitable();
    const writeWaitable = this.createWaitable();
    
    const future = new InternalFuture({
      tableIdx,
      componentIdx: this.#componentIdx,
      elemMeta,
      readWaitable,
      writeWaitable,
      hostInjectFn,
    });
    future.setGlobalFutureMapRep(FUTURES.insert(future));
    
    const writeEnd = future.writeEnd();
    writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
    writeEnd.setHandle(futureTable.insert(writeEnd));
    if (writeEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
    
    const writeEndWaitableIdx = writeEnd.waitableIdx();
    const writeEndHandle = writeEnd.handle();
    writeWaitable.setTarget(`waitable for future write end (waitable [${writeEndWaitableIdx}])`);
    writeEnd.setTarget(`future write end (waitable [${writeEndWaitableIdx}])`);
    
    const readEnd = future.readEnd();
    readEnd.setWaitableIdx(this.handles.insert(readEnd));
    readEnd.setHandle(futureTable.insert(readEnd));
    if (readEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
    
    const readEndWaitableIdx = readEnd.waitableIdx();
    const readEndHandle = readEnd.handle();
    readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
    readEnd.setTarget(`future read end (waitable [${readEndWaitableIdx}])`);
    
    return {
      writeEnd,
      writeEndWaitableIdx,
      writeEndHandle,
      readEndWaitableIdx,
      readEndHandle,
      readEnd,
    };
  }
  
  getFutureEnd(args) {
    _debugLog('[ComponentAsyncState#getFutureEnd()] args', args);
    const { tableIdx, futureEndHandle, futureEndWaitableIdx } = args;
    if (tableIdx === undefined) {
      throw new Error('missing table idx while getting future end');
    }
    
    const { table, componentIdx } = FUTURE_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    let futureEnd;
    if (futureEndWaitableIdx !== undefined) {
      futureEnd = cstate.handles.get(futureEndWaitableIdx);
    } else if (futureEndHandle !== undefined) {
      if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting future end`); }
      futureEnd = table.get(futureEndHandle);
    } else {
      throw new TypeError("must specify either waitable idx or handle to retrieve future");
    }
    
    if (!futureEnd) {
      throw new Error(`missing future end (tableIdx [${tableIdx}], handle [${futureEndHandle}], waitableIdx [${futureEndWaitableIdx}])`);
    }
    if (tableIdx && futureEnd.futureTableIdx() !== tableIdx) {
      throw new Error(`future end table idx [${futureEnd.futureTableIdx()}] does not match [${tableIdx}]`);
    }
    
    return futureEnd;
  }
  
  removeFutureEndFromTable(args) {
    _debugLog('[ComponentAsyncState#removeFutureEndFromTable()] args', args);
    
    const { tableIdx, futureWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing future end"); }
    if (futureWaitableIdx === undefined) {
      throw new Error("missing future end waitable idx while removing future end");
    }
    
    const { table, componentIdx } = FUTURE_TABLES[tableIdx];
    if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing future end`); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const futureEnd = cstate.handles.get(futureWaitableIdx);
    if (!futureEnd) {
      throw new Error(`missing future end (handle [${futureWaitableIdx}], table [${tableIdx}])`);
    }
    const handle = futureEnd.handle();
    
    let removed = cstate.handles.remove(futureWaitableIdx);
    if (!removed) {
      throw new Error(`failed to remove futureEnd from handles (waitable idx [${futureWaitableIdx}]), component [${componentIdx}])`);
    }
    
    removed = table.remove(handle);
    if (!removed) {
      throw new Error(`failed to remove futureEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
    }
    
    return futureEnd;
  }
  
}

function clampGuest(i, min, max) {
  if (i < min || i > max) {
    throw new TypeError(`must be between ${min} and ${max}`);
  }
  return i;
}


const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let _fs;
async function fetchCompile (url) {
  if (isNode) {
    _fs = _fs || await import('node:fs/promises');
    return WebAssembly.compile(await _fs.readFile(url));
  }
  return fetch(url).then(WebAssembly.compileStreaming);
}

const symbolCabiDispose = Symbol.for('cabiDispose');

const symbolRscHandle = Symbol('handle');

const symbolRscRep = Symbol.for('cabiRep');

const HANDLE_TABLES= [];


function getErrorPayload(e) {
  if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
  if (e instanceof Error) throw e;
  return e;
}

const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const hasOwnProperty = Object.prototype.hasOwnProperty;


if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
const module0 = getCoreModule('gdbstub.core.wasm');
const module1 = getCoreModule('gdbstub.core2.wasm');
const module2 = getCoreModule('gdbstub.core3.wasm');

const { Debuggee, EventFuture, Frame, Global, Instance, Memory, Module, WasmException, WasmFunc, WasmValue } = imports['bytecodealliance:wasmtime/debuggee'];

if (Debuggee=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Debuggee', was 'Debuggee' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (EventFuture=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'EventFuture', was 'EventFuture' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (Frame=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Frame', was 'Frame' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (Global=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Global', was 'Global' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (Instance=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Instance', was 'Instance' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (Memory=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Memory', was 'Memory' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (Module=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Module', was 'Module' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (WasmException=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'WasmException', was 'WasmException' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (WasmFunc=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'WasmFunc', was 'WasmFunc' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (WasmValue=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'WasmValue', was 'WasmValue' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const logLine = imports['log-line'].default;
const printDebuggerInfo = imports['print-debugger-info'].default;
const { getEnvironment } = imports['wasi:cli/environment'];

if (getEnvironment=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getEnvironment', was 'getEnvironment' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { exit } = imports['wasi:cli/exit'];

if (exit=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'exit', was 'exit' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStderr } = imports['wasi:cli/stderr'];

if (getStderr=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStderr', was 'getStderr' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdin } = imports['wasi:cli/stdin'];

if (getStdin=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdin', was 'getStdin' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdout } = imports['wasi:cli/stdout'];

if (getStdout=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdout', was 'getStdout' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { TerminalInput } = imports['wasi:cli/terminal-input'];

if (TerminalInput=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'TerminalInput', was 'TerminalInput' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { TerminalOutput } = imports['wasi:cli/terminal-output'];

if (TerminalOutput=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'TerminalOutput', was 'TerminalOutput' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStderr } = imports['wasi:cli/terminal-stderr'];

if (getTerminalStderr=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStderr', was 'getTerminalStderr' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStdin } = imports['wasi:cli/terminal-stdin'];

if (getTerminalStdin=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStdin', was 'getTerminalStdin' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getTerminalStdout } = imports['wasi:cli/terminal-stdout'];

if (getTerminalStdout=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getTerminalStdout', was 'getTerminalStdout' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { subscribeDuration } = imports['wasi:clocks/monotonic-clock'];

if (subscribeDuration=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'subscribeDuration', was 'subscribeDuration' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Error: Error$1 } = imports['wasi:io/error'];

if (Error$1=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Error$1', was 'Error' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Pollable, poll } = imports['wasi:io/poll'];

if (Pollable=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Pollable', was 'Pollable' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (poll=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'poll', was 'poll' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { InputStream, OutputStream } = imports['wasi:io/streams'];

if (InputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'InputStream', was 'InputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (OutputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'OutputStream', was 'OutputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { insecureSeed } = imports['wasi:random/insecure-seed'];

if (insecureSeed=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'insecureSeed', was 'insecureSeed' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { instanceNetwork } = imports['wasi:sockets/instance-network'];

if (instanceNetwork=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'instanceNetwork', was 'instanceNetwork' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Network } = imports['wasi:sockets/network'];

if (Network=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Network', was 'Network' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { TcpSocket } = imports['wasi:sockets/tcp'];

if (TcpSocket=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'TcpSocket', was 'TcpSocket' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { createTcpSocket } = imports['wasi:sockets/tcp-create-socket'];

if (createTcpSocket=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'createTcpSocket', was 'createTcpSocket' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

let gen = (function* _initGenerator () {
  let exports0;
  
  const handleTable2 = [T_FLAG, 0];
  handleTable2._createdReps = new Set();
  
  
  const captureTable2= new Map();
  let captureCnt2= 0;
  
  HANDLE_TABLES[2] = handleTable2;
  
  const _trampoline4 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.clone"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'clone',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.clone(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof WasmValue)) {
      throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt2;
      captureTable2.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable2, rep);
    }
    
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.clone"][Instruction::Return]', {
      funcName: '[method]wasm-value.clone',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline4.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#clone';
  
  const handleTable4 = [T_FLAG, 0];
  handleTable4._createdReps = new Set();
  
  
  const captureTable4= new Map();
  let captureCnt4= 0;
  
  HANDLE_TABLES[4] = handleTable4;
  
  const _trampoline9 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable4.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Debuggee.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.stopped-thread"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'stoppedThread',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.stoppedThread(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.stopped-thread"][Instruction::Return]', {
      funcName: '[method]debuggee.stopped-thread',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint32(ret)]);
    task.exit();
    return toUint32(ret);
  }
  _trampoline9.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#stoppedThread';
  
  const _trampoline10 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-i32"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'unwrapI32',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.unwrapI32(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-i32"][Instruction::Return]', {
      funcName: '[method]wasm-value.unwrap-i32',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint32(ret)]);
    task.exit();
    return toUint32(ret);
  }
  _trampoline10.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#unwrapI32';
  
  const _trampoline11 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-i64"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'unwrapI64',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.unwrapI64(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-i64"][Instruction::Return]', {
      funcName: '[method]wasm-value.unwrap-i64',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline11.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#unwrapI64';
  
  const _trampoline12 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-f32"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'unwrapF32',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.unwrapF32(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-f32"][Instruction::Return]', {
      funcName: '[method]wasm-value.unwrap-f32',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([+ret]);
    task.exit();
    return +ret;
  }
  _trampoline12.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#unwrapF32';
  
  const _trampoline13 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-f64"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'unwrapF64',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.unwrapF64(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-f64"][Instruction::Return]', {
      funcName: '[method]wasm-value.unwrap-f64',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([+ret]);
    task.exit();
    return +ret;
  }
  _trampoline13.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#unwrapF64';
  
  const handleTable8 = [T_FLAG, 0];
  handleTable8._createdReps = new Set();
  
  
  const captureTable8= new Map();
  let captureCnt8= 0;
  
  HANDLE_TABLES[8] = handleTable8;
  
  const _trampoline15 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable8.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Memory.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var handle4 = arg1;
    
    var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable4.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(Debuggee.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    
    curResourceBorrows.push(rsc3);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.size-bytes"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'sizeBytes',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.sizeBytes(rsc3),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.size-bytes"][Instruction::Return]', {
      funcName: '[method]memory.size-bytes',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline15.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#sizeBytes';
  
  const _trampoline16 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable8.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Memory.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.clone"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'clone',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.clone(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Memory)) {
      throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt8;
      captureTable8.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable8, rep);
    }
    
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.clone"][Instruction::Return]', {
      funcName: '[method]memory.clone',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline16.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#clone';
  
  const _trampoline17 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable8.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Memory.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.unique-id"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'uniqueId',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.uniqueId(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.unique-id"][Instruction::Return]', {
      funcName: '[method]memory.unique-id',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline17.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#uniqueId';
  
  const handleTable7 = [T_FLAG, 0];
  handleTable7._createdReps = new Set();
  
  
  const captureTable7= new Map();
  let captureCnt7= 0;
  
  HANDLE_TABLES[7] = handleTable7;
  
  const _trampoline18 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable7.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Module.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.clone"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'clone',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.clone(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Module)) {
      throw new TypeError('Resource error: Not a valid \"Module\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt7;
      captureTable7.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable7, rep);
    }
    
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.clone"][Instruction::Return]', {
      funcName: '[method]module.clone',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline18.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#clone';
  
  const _trampoline19 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable7.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Module.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.unique-id"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'uniqueId',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.uniqueId(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.unique-id"][Instruction::Return]', {
      funcName: '[method]module.unique-id',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline19.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#uniqueId';
  
  const handleTable5 = [T_FLAG, 0];
  handleTable5._createdReps = new Set();
  
  
  const captureTable5= new Map();
  let captureCnt5= 0;
  
  HANDLE_TABLES[5] = handleTable5;
  
  const _trampoline20 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable5.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Instance.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var handle4 = arg1;
    
    var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable4.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(Debuggee.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    
    curResourceBorrows.push(rsc3);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-module"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getModule',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.getModule(rsc3),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Module)) {
      throw new TypeError('Resource error: Not a valid \"Module\" resource.');
    }
    var handle6 = ret[symbolRscHandle];
    if (!handle6) {
      const rep = ret[symbolRscRep] || ++captureCnt7;
      captureTable7.set(rep, ret);
      handle6 = rscTableCreateOwn(handleTable7, rep);
    }
    
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-module"][Instruction::Return]', {
      funcName: '[method]instance.get-module',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle6]);
    task.exit();
    return handle6;
  }
  _trampoline20.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getModule';
  
  const _trampoline21 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable2.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(WasmValue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.get-type"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getType',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.getType(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant3 = ret;
    let variant3_0;
    switch (variant3.tag) {
      case 'wasm-i32': {
        variant3_0 = 0;
        break;
      }
      case 'wasm-i64': {
        variant3_0 = 1;
        break;
      }
      case 'wasm-f32': {
        variant3_0 = 2;
        break;
      }
      case 'wasm-f64': {
        variant3_0 = 3;
        break;
      }
      case 'wasm-v128': {
        variant3_0 = 4;
        break;
      }
      case 'wasm-funcref': {
        variant3_0 = 5;
        break;
      }
      case 'wasm-exnref': {
        variant3_0 = 6;
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant3.tag)}\` (received \`${variant3}\`) specified for \`WasmType\``);
      }
    }
    _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.get-type"][Instruction::Return]', {
      funcName: '[method]wasm-value.get-type',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([variant3_0]);
    task.exit();
    return variant3_0;
  }
  _trampoline21.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getType';
  
  const handleTable13 = [T_FLAG, 0];
  handleTable13._createdReps = new Set();
  
  
  const captureTable13= new Map();
  let captureCnt13= 0;
  
  HANDLE_TABLES[13] = handleTable13;
  
  const handleTable0 = [T_FLAG, 0];
  handleTable0._createdReps = new Set();
  
  
  const captureTable0= new Map();
  let captureCnt0= 0;
  
  HANDLE_TABLES[0] = handleTable0;
  
  const _trampoline28 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable13[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable13.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(OutputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'subscribe',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.subscribe(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Pollable)) {
      throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.subscribe"][Instruction::Return]', {
      funcName: '[method]output-stream.subscribe',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline28.fnName = 'wasi:io/streams@0.2.12#subscribe';
  
  const handleTable12 = [T_FLAG, 0];
  handleTable12._createdReps = new Set();
  
  
  const captureTable12= new Map();
  let captureCnt12= 0;
  
  HANDLE_TABLES[12] = handleTable12;
  
  const _trampoline30 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable12[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable12.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(InputStream.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'subscribe',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.subscribe(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Pollable)) {
      throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.subscribe"][Instruction::Return]', {
      funcName: '[method]input-stream.subscribe',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline30.fnName = 'wasi:io/streams@0.2.12#subscribe';
  
  const _trampoline31 = function(arg0) {
    _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-duration"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'subscribeDuration',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => subscribeDuration(BigInt.asUintN(64, BigInt(arg0))),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof Pollable)) {
      throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-duration"][Instruction::Return]', {
      funcName: 'subscribe-duration',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline31.fnName = 'wasi:clocks/monotonic-clock@0.2.12#subscribeDuration';
  
  const _trampoline32 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable0.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Pollable.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:io/poll@0.2.12", function="[method]pollable.ready"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'ready',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.ready(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:io/poll@0.2.12", function="[method]pollable.ready"][Instruction::Return]', {
      funcName: '[method]pollable.ready',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([ret ? 1 : 0]);
    task.exit();
    return ret ? 1 : 0;
  }
  _trampoline32.fnName = 'wasi:io/poll@0.2.12#ready';
  
  const handleTable16 = [T_FLAG, 0];
  handleTable16._createdReps = new Set();
  
  
  const captureTable16= new Map();
  let captureCnt16= 0;
  
  HANDLE_TABLES[16] = handleTable16;
  
  const _trampoline33 = function() {
    _debugLog('[iface="wasi:sockets/instance-network@0.2.12", function="instance-network"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'instanceNetwork',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => instanceNetwork(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof Network)) {
      throw new TypeError('Resource error: Not a valid \"Network\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt16;
      captureTable16.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable16, rep);
    }
    
    _debugLog('[iface="wasi:sockets/instance-network@0.2.12", function="instance-network"][Instruction::Return]', {
      funcName: 'instance-network',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline33.fnName = 'wasi:sockets/instance-network@0.2.12#instanceNetwork';
  
  const handleTable17 = [T_FLAG, 0];
  handleTable17._createdReps = new Set();
  
  
  const captureTable17= new Map();
  let captureCnt17= 0;
  
  HANDLE_TABLES[17] = handleTable17;
  
  const _trampoline34 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable17.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(TcpSocket.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'subscribe',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.subscribe(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const rsc of curResourceBorrows) {
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Pollable)) {
      throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.subscribe"][Instruction::Return]', {
      funcName: '[method]tcp-socket.subscribe',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline34.fnName = 'wasi:sockets/tcp@0.2.12#subscribe';
  
  const _trampoline35 = function() {
    _debugLog('[iface="wasi:cli/stderr@0.2.12", function="get-stderr"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStderr',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStderr(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt13;
      captureTable13.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable13, rep);
    }
    
    _debugLog('[iface="wasi:cli/stderr@0.2.12", function="get-stderr"][Instruction::Return]', {
      funcName: 'get-stderr',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline35.fnName = 'wasi:cli/stderr@0.2.12#getStderr';
  
  const _trampoline36 = function() {
    _debugLog('[iface="wasi:cli/stdout@0.2.12", function="get-stdout"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdout',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdout(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt13;
      captureTable13.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable13, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdout@0.2.12", function="get-stdout"][Instruction::Return]', {
      funcName: 'get-stdout',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline36.fnName = 'wasi:cli/stdout@0.2.12#getStdout';
  
  const _trampoline39 = function(arg0) {
    let variant0;
    switch (arg0) {
      case 0: {
        variant0= {
          tag: 'ok',
          val: undefined
        };
        break;
      }
      case 1: {
        variant0= {
          tag: 'err',
          val: undefined
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for expected');
      }
    }
    _debugLog('[iface="wasi:cli/exit@0.2.12", function="exit"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'exit',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => exit(variant0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="wasi:cli/exit@0.2.12", function="exit"][Instruction::Return]', {
      funcName: 'exit',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline39.fnName = 'wasi:cli/exit@0.2.12#exit';
  
  const _trampoline40 = function() {
    _debugLog('[iface="wasi:cli/stdin@0.2.12", function="get-stdin"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdin',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdin(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof InputStream)) {
      throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt12;
      captureTable12.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable12, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdin@0.2.12", function="get-stdin"][Instruction::Return]', {
      funcName: 'get-stdin',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline40.fnName = 'wasi:cli/stdin@0.2.12#getStdin';
  let exports1;
  let memory0;
  let realloc0;
  let realloc0Async;
  
  const _trampoline41 = function(arg0, arg1) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    _debugLog('[iface="print-debugger-info", function="print-debugger-info"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'printDebuggerInfo',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => printDebuggerInfo(result0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="print-debugger-info", function="print-debugger-info"][Instruction::Return]', {
      funcName: 'print-debugger-info',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline41.fnName = 'print-debugger-info#printDebuggerInfo';
  
  const _trampoline42 = function(arg0, arg1) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    _debugLog('[iface="log-line", function="log-line"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'logLine',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => logLine(result0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: currentSubtask?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="log-line", function="log-line"][Instruction::Return]', {
      funcName: 'log-line',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline42.fnName = 'log-line#logLine';
  
  const _trampoline43 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11, arg12, arg13, arg14) {
    var handle1 = arg0;
    
    var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable17.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(TcpSocket.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var handle4 = arg1;
    
    var rep5 = handleTable16[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable16.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(Network.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    
    curResourceBorrows.push(rsc3);
    let variant6;
    switch (arg2) {
      case 0: {
        variant6= {
          tag: 'ipv4',
          val: {
            port: clampGuest(arg3, 0, 65535),
            address: [clampGuest(arg4, 0, 255), clampGuest(arg5, 0, 255), clampGuest(arg6, 0, 255), clampGuest(arg7, 0, 255)],
          }
        };
        break;
      }
      case 1: {
        variant6= {
          tag: 'ipv6',
          val: {
            port: clampGuest(arg3, 0, 65535),
            flowInfo: arg4 >>> 0,
            address: [clampGuest(arg5, 0, 65535), clampGuest(arg6, 0, 65535), clampGuest(arg7, 0, 65535), clampGuest(arg8, 0, 65535), clampGuest(arg9, 0, 65535), clampGuest(arg10, 0, 65535), clampGuest(arg11, 0, 65535), clampGuest(arg12, 0, 65535)],
            scopeId: arg13 >>> 0,
          }
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for IpSocketAddress');
      }
    }
    _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.start-bind"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'startBind',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.startBind(rsc3, variant6),
      })
    };
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var variant8 = ret;
  switch (variant8.tag) {
    case 'ok': {
      const e = variant8.val;
      dataView(memory0).setInt8(arg14 + 0, 0, true);
      
      break;
    }
    case 'err': {
      const e = variant8.val;
      dataView(memory0).setInt8(arg14 + 0, 1, true);
      var val7 = e;
      let enum7;
      switch (val7) {
        case 'unknown': {
          enum7 = 0;
          break;
        }
        case 'access-denied': {
          enum7 = 1;
          break;
        }
        case 'not-supported': {
          enum7 = 2;
          break;
        }
        case 'invalid-argument': {
          enum7 = 3;
          break;
        }
        case 'out-of-memory': {
          enum7 = 4;
          break;
        }
        case 'timeout': {
          enum7 = 5;
          break;
        }
        case 'concurrency-conflict': {
          enum7 = 6;
          break;
        }
        case 'not-in-progress': {
          enum7 = 7;
          break;
        }
        case 'would-block': {
          enum7 = 8;
          break;
        }
        case 'invalid-state': {
          enum7 = 9;
          break;
        }
        case 'new-socket-limit': {
          enum7 = 10;
          break;
        }
        case 'address-not-bindable': {
          enum7 = 11;
          break;
        }
        case 'address-in-use': {
          enum7 = 12;
          break;
        }
        case 'remote-unreachable': {
          enum7 = 13;
          break;
        }
        case 'connection-refused': {
          enum7 = 14;
          break;
        }
        case 'connection-reset': {
          enum7 = 15;
          break;
        }
        case 'connection-aborted': {
          enum7 = 16;
          break;
        }
        case 'datagram-too-large': {
          enum7 = 17;
          break;
        }
        case 'name-unresolvable': {
          enum7 = 18;
          break;
        }
        case 'temporary-resolver-failure': {
          enum7 = 19;
          break;
        }
        case 'permanent-resolver-failure': {
          enum7 = 20;
          break;
        }
        default: {
          if ((e) instanceof Error) {
            console.error(e);
          }
          
          throw new TypeError(`"${val7}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg14 + 1, enum7, true);
      
      break;
    }
    default: {
      _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.start-bind"][Instruction::Return]', {
    funcName: '[method]tcp-socket.start-bind',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline43.fnName = 'wasi:sockets/tcp@0.2.12#startBind';

const _trampoline44 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.finish-bind"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'finishBind',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.finishBind(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant4 = ret;
switch (variant4.tag) {
  case 'ok': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    let enum3;
    switch (val3) {
      case 'unknown': {
        enum3 = 0;
        break;
      }
      case 'access-denied': {
        enum3 = 1;
        break;
      }
      case 'not-supported': {
        enum3 = 2;
        break;
      }
      case 'invalid-argument': {
        enum3 = 3;
        break;
      }
      case 'out-of-memory': {
        enum3 = 4;
        break;
      }
      case 'timeout': {
        enum3 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum3 = 6;
        break;
      }
      case 'not-in-progress': {
        enum3 = 7;
        break;
      }
      case 'would-block': {
        enum3 = 8;
        break;
      }
      case 'invalid-state': {
        enum3 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum3 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum3 = 11;
        break;
      }
      case 'address-in-use': {
        enum3 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum3 = 13;
        break;
      }
      case 'connection-refused': {
        enum3 = 14;
        break;
      }
      case 'connection-reset': {
        enum3 = 15;
        break;
      }
      case 'connection-aborted': {
        enum3 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum3 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum3 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum3 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum3 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val3}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 1, enum3, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant4, valueType: typeof variant4});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.finish-bind"][Instruction::Return]', {
  funcName: '[method]tcp-socket.finish-bind',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline44.fnName = 'wasi:sockets/tcp@0.2.12#finishBind';

const _trampoline45 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.start-listen"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'startListen',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.startListen(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant4 = ret;
switch (variant4.tag) {
  case 'ok': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    let enum3;
    switch (val3) {
      case 'unknown': {
        enum3 = 0;
        break;
      }
      case 'access-denied': {
        enum3 = 1;
        break;
      }
      case 'not-supported': {
        enum3 = 2;
        break;
      }
      case 'invalid-argument': {
        enum3 = 3;
        break;
      }
      case 'out-of-memory': {
        enum3 = 4;
        break;
      }
      case 'timeout': {
        enum3 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum3 = 6;
        break;
      }
      case 'not-in-progress': {
        enum3 = 7;
        break;
      }
      case 'would-block': {
        enum3 = 8;
        break;
      }
      case 'invalid-state': {
        enum3 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum3 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum3 = 11;
        break;
      }
      case 'address-in-use': {
        enum3 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum3 = 13;
        break;
      }
      case 'connection-refused': {
        enum3 = 14;
        break;
      }
      case 'connection-reset': {
        enum3 = 15;
        break;
      }
      case 'connection-aborted': {
        enum3 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum3 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum3 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum3 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum3 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val3}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 1, enum3, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant4, valueType: typeof variant4});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.start-listen"][Instruction::Return]', {
  funcName: '[method]tcp-socket.start-listen',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline45.fnName = 'wasi:sockets/tcp@0.2.12#startListen';

const _trampoline46 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.finish-listen"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'finishListen',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.finishListen(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant4 = ret;
switch (variant4.tag) {
  case 'ok': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant4.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    let enum3;
    switch (val3) {
      case 'unknown': {
        enum3 = 0;
        break;
      }
      case 'access-denied': {
        enum3 = 1;
        break;
      }
      case 'not-supported': {
        enum3 = 2;
        break;
      }
      case 'invalid-argument': {
        enum3 = 3;
        break;
      }
      case 'out-of-memory': {
        enum3 = 4;
        break;
      }
      case 'timeout': {
        enum3 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum3 = 6;
        break;
      }
      case 'not-in-progress': {
        enum3 = 7;
        break;
      }
      case 'would-block': {
        enum3 = 8;
        break;
      }
      case 'invalid-state': {
        enum3 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum3 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum3 = 11;
        break;
      }
      case 'address-in-use': {
        enum3 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum3 = 13;
        break;
      }
      case 'connection-refused': {
        enum3 = 14;
        break;
      }
      case 'connection-reset': {
        enum3 = 15;
        break;
      }
      case 'connection-aborted': {
        enum3 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum3 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum3 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum3 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum3 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val3}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 1, enum3, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant4, valueType: typeof variant4});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.finish-listen"][Instruction::Return]', {
  funcName: '[method]tcp-socket.finish-listen',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline46.fnName = 'wasi:sockets/tcp@0.2.12#finishListen';

const _trampoline47 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.local-address"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'localAddress',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.localAddress(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant9 = ret;
switch (variant9.tag) {
  case 'ok': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    var variant7 = e;
    switch (variant7.tag) {
      case 'ipv4': {
        const e = variant7.val;
        dataView(memory0).setInt8(arg1 + 4, 0, true);
        var {port: v3_0, address: v3_1 } = e;
        dataView(memory0).setInt16(arg1 + 8, toUint16(v3_0), true);
        var [tuple4_0, tuple4_1, tuple4_2, tuple4_3] = v3_1;
        dataView(memory0).setInt8(arg1 + 10, toUint8(tuple4_0), true);
        dataView(memory0).setInt8(arg1 + 11, toUint8(tuple4_1), true);
        dataView(memory0).setInt8(arg1 + 12, toUint8(tuple4_2), true);
        dataView(memory0).setInt8(arg1 + 13, toUint8(tuple4_3), true);
        break;
      }
      case 'ipv6': {
        const e = variant7.val;
        dataView(memory0).setInt8(arg1 + 4, 1, true);
        var {port: v5_0, flowInfo: v5_1, address: v5_2, scopeId: v5_3 } = e;
        dataView(memory0).setInt16(arg1 + 8, toUint16(v5_0), true);
        dataView(memory0).setInt32(arg1 + 12, toUint32(v5_1), true);
        var [tuple6_0, tuple6_1, tuple6_2, tuple6_3, tuple6_4, tuple6_5, tuple6_6, tuple6_7] = v5_2;
        dataView(memory0).setInt16(arg1 + 16, toUint16(tuple6_0), true);
        dataView(memory0).setInt16(arg1 + 18, toUint16(tuple6_1), true);
        dataView(memory0).setInt16(arg1 + 20, toUint16(tuple6_2), true);
        dataView(memory0).setInt16(arg1 + 22, toUint16(tuple6_3), true);
        dataView(memory0).setInt16(arg1 + 24, toUint16(tuple6_4), true);
        dataView(memory0).setInt16(arg1 + 26, toUint16(tuple6_5), true);
        dataView(memory0).setInt16(arg1 + 28, toUint16(tuple6_6), true);
        dataView(memory0).setInt16(arg1 + 30, toUint16(tuple6_7), true);
        dataView(memory0).setInt32(arg1 + 32, toUint32(v5_3), true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant7.tag)}\` (received \`${variant7}\`) specified for \`IpSocketAddress\``);
      }
    }
    
    break;
  }
  case 'err': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val8 = e;
    let enum8;
    switch (val8) {
      case 'unknown': {
        enum8 = 0;
        break;
      }
      case 'access-denied': {
        enum8 = 1;
        break;
      }
      case 'not-supported': {
        enum8 = 2;
        break;
      }
      case 'invalid-argument': {
        enum8 = 3;
        break;
      }
      case 'out-of-memory': {
        enum8 = 4;
        break;
      }
      case 'timeout': {
        enum8 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum8 = 6;
        break;
      }
      case 'not-in-progress': {
        enum8 = 7;
        break;
      }
      case 'would-block': {
        enum8 = 8;
        break;
      }
      case 'invalid-state': {
        enum8 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum8 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum8 = 11;
        break;
      }
      case 'address-in-use': {
        enum8 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum8 = 13;
        break;
      }
      case 'connection-refused': {
        enum8 = 14;
        break;
      }
      case 'connection-reset': {
        enum8 = 15;
        break;
      }
      case 'connection-aborted': {
        enum8 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum8 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum8 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum8 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum8 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val8}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 4, enum8, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant9, valueType: typeof variant9});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.local-address"][Instruction::Return]', {
  funcName: '[method]tcp-socket.local-address',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline47.fnName = 'wasi:sockets/tcp@0.2.12#localAddress';

const _trampoline48 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.accept"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'accept',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.accept(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    var [tuple3_0, tuple3_1, tuple3_2] = e;
    
    if (!(tuple3_0 instanceof TcpSocket)) {
      throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
    }
    var handle4 = tuple3_0[symbolRscHandle];
    if (!handle4) {
      const rep = tuple3_0[symbolRscRep] || ++captureCnt17;
      captureTable17.set(rep, tuple3_0);
      handle4 = rscTableCreateOwn(handleTable17, rep);
    }
    
    dataView(memory0).setInt32(arg1 + 4, handle4, true);
    
    if (!(tuple3_1 instanceof InputStream)) {
      throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
    }
    var handle5 = tuple3_1[symbolRscHandle];
    if (!handle5) {
      const rep = tuple3_1[symbolRscRep] || ++captureCnt12;
      captureTable12.set(rep, tuple3_1);
      handle5 = rscTableCreateOwn(handleTable12, rep);
    }
    
    dataView(memory0).setInt32(arg1 + 8, handle5, true);
    
    if (!(tuple3_2 instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle6 = tuple3_2[symbolRscHandle];
    if (!handle6) {
      const rep = tuple3_2[symbolRscRep] || ++captureCnt13;
      captureTable13.set(rep, tuple3_2);
      handle6 = rscTableCreateOwn(handleTable13, rep);
    }
    
    dataView(memory0).setInt32(arg1 + 12, handle6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'unknown': {
        enum7 = 0;
        break;
      }
      case 'access-denied': {
        enum7 = 1;
        break;
      }
      case 'not-supported': {
        enum7 = 2;
        break;
      }
      case 'invalid-argument': {
        enum7 = 3;
        break;
      }
      case 'out-of-memory': {
        enum7 = 4;
        break;
      }
      case 'timeout': {
        enum7 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum7 = 6;
        break;
      }
      case 'not-in-progress': {
        enum7 = 7;
        break;
      }
      case 'would-block': {
        enum7 = 8;
        break;
      }
      case 'invalid-state': {
        enum7 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum7 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum7 = 11;
        break;
      }
      case 'address-in-use': {
        enum7 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum7 = 13;
        break;
      }
      case 'connection-refused': {
        enum7 = 14;
        break;
      }
      case 'connection-reset': {
        enum7 = 15;
        break;
      }
      case 'connection-aborted': {
        enum7 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum7 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum7 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum7 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum7 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.accept"][Instruction::Return]', {
  funcName: '[method]tcp-socket.accept',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline48.fnName = 'wasi:sockets/tcp@0.2.12#accept';

const _trampoline49 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable17.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(TcpSocket.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  let enum3;
  switch (arg1) {
    case 0: {
      enum3 = 'receive';
      break;
    }
    case 1: {
      enum3 = 'send';
      break;
    }
    case 2: {
      enum3 = 'both';
      break;
    }
    default: {
      throw new TypeError('invalid discriminant specified for ShutdownType');
    }
  }
  _debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.shutdown"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'shutdown',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.shutdown(enum3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val4 = e;
    let enum4;
    switch (val4) {
      case 'unknown': {
        enum4 = 0;
        break;
      }
      case 'access-denied': {
        enum4 = 1;
        break;
      }
      case 'not-supported': {
        enum4 = 2;
        break;
      }
      case 'invalid-argument': {
        enum4 = 3;
        break;
      }
      case 'out-of-memory': {
        enum4 = 4;
        break;
      }
      case 'timeout': {
        enum4 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum4 = 6;
        break;
      }
      case 'not-in-progress': {
        enum4 = 7;
        break;
      }
      case 'would-block': {
        enum4 = 8;
        break;
      }
      case 'invalid-state': {
        enum4 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum4 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum4 = 11;
        break;
      }
      case 'address-in-use': {
        enum4 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum4 = 13;
        break;
      }
      case 'connection-refused': {
        enum4 = 14;
        break;
      }
      case 'connection-reset': {
        enum4 = 15;
        break;
      }
      case 'connection-aborted': {
        enum4 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum4 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum4 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum4 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum4 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val4}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg2 + 1, enum4, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp@0.2.12", function="[method]tcp-socket.shutdown"][Instruction::Return]', {
  funcName: '[method]tcp-socket.shutdown',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline49.fnName = 'wasi:sockets/tcp@0.2.12#shutdown';

const handleTable3 = [T_FLAG, 0];
handleTable3._createdReps = new Set();


const captureTable3= new Map();
let captureCnt3= 0;

HANDLE_TABLES[3] = handleTable3;

const _trampoline50 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Frame.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-instance"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getInstance',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getInstance(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    
    if (!(e instanceof Instance)) {
      throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
    }
    var handle6 = e[symbolRscHandle];
    if (!handle6) {
      const rep = e[symbolRscRep] || ++captureCnt5;
      captureTable5.set(rep, e);
      handle6 = rscTableCreateOwn(handleTable5, rep);
    }
    
    dataView(memory0).setInt32(arg2 + 4, handle6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'invalid-entity': {
        enum7 = 0;
        break;
      }
      case 'invalid-pc': {
        enum7 = 1;
        break;
      }
      case 'invalid-frame': {
        enum7 = 2;
        break;
      }
      case 'unsupported-type': {
        enum7 = 3;
        break;
      }
      case 'mismatched-type': {
        enum7 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum7 = 5;
        break;
      }
      case 'alloc-failure': {
        enum7 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum7 = 7;
        break;
      }
      case 'read-only': {
        enum7 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum7 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum7 = 10;
        break;
      }
      case 'execution-trap': {
        enum7 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-instance"][Instruction::Return]', {
  funcName: '[method]frame.get-instance',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline50.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getInstance';

const handleTable6 = [T_FLAG, 0];
handleTable6._createdReps = new Set();


const captureTable6= new Map();
let captureCnt6= 0;

HANDLE_TABLES[6] = handleTable6;

const _trampoline51 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Instance.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-global"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getGlobal',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getGlobal(rsc3, arg2 >>> 0),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    if (!(e instanceof Global)) {
      throw new TypeError('Resource error: Not a valid \"Global\" resource.');
    }
    var handle6 = e[symbolRscHandle];
    if (!handle6) {
      const rep = e[symbolRscRep] || ++captureCnt6;
      captureTable6.set(rep, e);
      handle6 = rscTableCreateOwn(handleTable6, rep);
    }
    
    dataView(memory0).setInt32(arg3 + 4, handle6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'invalid-entity': {
        enum7 = 0;
        break;
      }
      case 'invalid-pc': {
        enum7 = 1;
        break;
      }
      case 'invalid-frame': {
        enum7 = 2;
        break;
      }
      case 'unsupported-type': {
        enum7 = 3;
        break;
      }
      case 'mismatched-type': {
        enum7 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum7 = 5;
        break;
      }
      case 'alloc-failure': {
        enum7 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum7 = 7;
        break;
      }
      case 'read-only': {
        enum7 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum7 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum7 = 10;
        break;
      }
      case 'execution-trap': {
        enum7 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg3 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-global"][Instruction::Return]', {
  funcName: '[method]instance.get-global',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline51.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getGlobal';

const _trampoline52 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable6.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Global.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]global.get"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'get',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.get(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    
    if (!(e instanceof WasmValue)) {
      throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
    }
    var handle6 = e[symbolRscHandle];
    if (!handle6) {
      const rep = e[symbolRscRep] || ++captureCnt2;
      captureTable2.set(rep, e);
      handle6 = rscTableCreateOwn(handleTable2, rep);
    }
    
    dataView(memory0).setInt32(arg2 + 4, handle6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'invalid-entity': {
        enum7 = 0;
        break;
      }
      case 'invalid-pc': {
        enum7 = 1;
        break;
      }
      case 'invalid-frame': {
        enum7 = 2;
        break;
      }
      case 'unsupported-type': {
        enum7 = 3;
        break;
      }
      case 'mismatched-type': {
        enum7 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum7 = 5;
        break;
      }
      case 'alloc-failure': {
        enum7 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum7 = 7;
        break;
      }
      case 'read-only': {
        enum7 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum7 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum7 = 10;
        break;
      }
      case 'execution-trap': {
        enum7 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]global.get"][Instruction::Return]', {
  funcName: '[method]global.get',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline52.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#get';

const _trampoline53 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Module.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.name"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'name',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.name(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  
  var encodeRes = _utf8AllocateAndEncode(ret, realloc0, memory0);
  var ptr3= encodeRes.ptr;
  var len3 = encodeRes.len;
  
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.name"][Instruction::Return]', {
    funcName: '[method]module.name',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline53.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#name';

const _trampoline54 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Module.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.add-breakpoint"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'addBreakpoint',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.addBreakpoint(rsc3, arg2 >>> 0),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant7 = ret;
switch (variant7.tag) {
  case 'ok': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var val6 = e;
    let enum6;
    switch (val6) {
      case 'invalid-entity': {
        enum6 = 0;
        break;
      }
      case 'invalid-pc': {
        enum6 = 1;
        break;
      }
      case 'invalid-frame': {
        enum6 = 2;
        break;
      }
      case 'unsupported-type': {
        enum6 = 3;
        break;
      }
      case 'mismatched-type': {
        enum6 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum6 = 5;
        break;
      }
      case 'alloc-failure': {
        enum6 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum6 = 7;
        break;
      }
      case 'read-only': {
        enum6 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum6 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum6 = 10;
        break;
      }
      case 'execution-trap': {
        enum6 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val6}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg3 + 1, enum6, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.add-breakpoint"][Instruction::Return]', {
  funcName: '[method]module.add-breakpoint',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline54.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#addBreakpoint';

const _trampoline55 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Module.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.remove-breakpoint"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'removeBreakpoint',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.removeBreakpoint(rsc3, arg2 >>> 0),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant7 = ret;
switch (variant7.tag) {
  case 'ok': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var val6 = e;
    let enum6;
    switch (val6) {
      case 'invalid-entity': {
        enum6 = 0;
        break;
      }
      case 'invalid-pc': {
        enum6 = 1;
        break;
      }
      case 'invalid-frame': {
        enum6 = 2;
        break;
      }
      case 'unsupported-type': {
        enum6 = 3;
        break;
      }
      case 'mismatched-type': {
        enum6 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum6 = 5;
        break;
      }
      case 'alloc-failure': {
        enum6 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum6 = 7;
        break;
      }
      case 'read-only': {
        enum6 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum6 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum6 = 10;
        break;
      }
      case 'execution-trap': {
        enum6 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val6}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg3 + 1, enum6, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.remove-breakpoint"][Instruction::Return]', {
  funcName: '[method]module.remove-breakpoint',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline55.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#removeBreakpoint';

const _trampoline56 = function(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  
  var rep2 = handleTable8[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable8.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Memory.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.get-bytes"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getBytes',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getBytes(rsc3, BigInt.asUintN(64, BigInt(arg2)), BigInt.asUintN(64, BigInt(arg3))),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg4 + 0, 0, true);
    var val6 = e;
    var len6 = Array.isArray(val6) ? val6.length : val6.byteLength;
    var ptr6 = realloc0(0, 0, 1, len6 * 1);
    
    let valData6;
    const valLenBytes6 = len6 * 1;
    if (Array.isArray(val6)) {
      // Regular array likely containing numbers, write values to memory
      let offset = 0;
      const dv6 = new DataView(memory0.buffer);
      for (const v of val6) {
        _requireValidNumericPrimitive.bind(null, 'u8')(v);
        dv6.setUint8(ptr6+ offset, v, true);
        offset += 1;
      }
    } else {
      // TypedArray / ArrayBuffer-like, direct copy
      valData6 = new Uint8Array(val6.buffer || val6, val6.byteOffset, valLenBytes6);
      const out6 = new Uint8Array(memory0.buffer, ptr6, valLenBytes6);
      out6.set(valData6);
    }
    
    dataView(memory0).setUint32(arg4 + 8, len6, true);
    dataView(memory0).setUint32(arg4 + 4, ptr6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg4 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'invalid-entity': {
        enum7 = 0;
        break;
      }
      case 'invalid-pc': {
        enum7 = 1;
        break;
      }
      case 'invalid-frame': {
        enum7 = 2;
        break;
      }
      case 'unsupported-type': {
        enum7 = 3;
        break;
      }
      case 'mismatched-type': {
        enum7 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum7 = 5;
        break;
      }
      case 'alloc-failure': {
        enum7 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum7 = 7;
        break;
      }
      case 'read-only': {
        enum7 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum7 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum7 = 10;
        break;
      }
      case 'execution-trap': {
        enum7 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg4 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]memory.get-bytes"][Instruction::Return]', {
  funcName: '[method]memory.get-bytes',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline56.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getBytes';

const _trampoline57 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.list-threads"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'listThreads',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.listThreads(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var val3 = ret;
  var len3 = val3.length;
  var ptr3 = realloc0(0, 0, 4, len3 * 4);
  
  let valData3;
  const valLenBytes3 = len3 * 4;
  if (Array.isArray(val3)) {
    // Regular array likely containing numbers, write values to memory
    let offset = 0;
    const dv3 = new DataView(memory0.buffer);
    for (const v of val3) {
      _requireValidNumericPrimitive.bind(null, 'u32')(v);
      dv3.setUint32(ptr3+ offset, v, true);
      offset += 4;
    }
  } else {
    // TypedArray / ArrayBuffer-like, direct copy
    valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
    const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
    out3.set(valData3);
  }
  
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.list-threads"][Instruction::Return]', {
    funcName: '[method]debuggee.list-threads',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline57.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#listThreads';

const _trampoline58 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable2.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(WasmValue.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-v128"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'unwrapV128',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.unwrapV128(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var val3 = ret;
  var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
  var ptr3 = realloc0(0, 0, 1, len3 * 1);
  
  let valData3;
  const valLenBytes3 = len3 * 1;
  if (Array.isArray(val3)) {
    // Regular array likely containing numbers, write values to memory
    let offset = 0;
    const dv3 = new DataView(memory0.buffer);
    for (const v of val3) {
      _requireValidNumericPrimitive.bind(null, 'u8')(v);
      dv3.setUint8(ptr3+ offset, v, true);
      offset += 1;
    }
  } else {
    // TypedArray / ArrayBuffer-like, direct copy
    valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
    const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
    out3.set(valData3);
  }
  
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]wasm-value.unwrap-v128"][Instruction::Return]', {
    funcName: '[method]wasm-value.unwrap-v128',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline58.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#unwrapV128';

const handleTable9 = [T_FLAG, 0];
handleTable9._createdReps = new Set();


const captureTable9= new Map();
let captureCnt9= 0;

HANDLE_TABLES[9] = handleTable9;

const handleTable1 = [T_FLAG, 0];
handleTable1._createdReps = new Set();


const captureTable1= new Map();
let captureCnt1= 0;

HANDLE_TABLES[1] = handleTable1;

const _trampoline59 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable9.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(EventFuture.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  else {
    captureTable9.delete(rep2);
  }
  rscTableRemove(handleTable9, handle1);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[static]event-future.finish"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'EventFuture.finish',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => EventFuture.finish(rsc0, rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant11 = ret;
switch (variant11.tag) {
  case 'ok': {
    const e = variant11.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    var variant9 = e;
    switch (variant9.tag) {
      case 'complete': {
        dataView(memory0).setInt8(arg2 + 4, 0, true);
        break;
      }
      case 'trap': {
        dataView(memory0).setInt8(arg2 + 4, 1, true);
        break;
      }
      case 'breakpoint': {
        dataView(memory0).setInt8(arg2 + 4, 2, true);
        break;
      }
      case 'interrupted': {
        dataView(memory0).setInt8(arg2 + 4, 3, true);
        break;
      }
      case 'exception': {
        const e = variant9.val;
        dataView(memory0).setInt8(arg2 + 4, 4, true);
        
        if (!(e instanceof WasmException)) {
          throw new TypeError('Resource error: Not a valid \"WasmException\" resource.');
        }
        var handle6 = e[symbolRscHandle];
        if (!handle6) {
          const rep = e[symbolRscRep] || ++captureCnt1;
          captureTable1.set(rep, e);
          handle6 = rscTableCreateOwn(handleTable1, rep);
        }
        
        dataView(memory0).setInt32(arg2 + 8, handle6, true);
        break;
      }
      case 'injected-call-return': {
        const e = variant9.val;
        dataView(memory0).setInt8(arg2 + 4, 5, true);
        var vec8 = e;
        var len8 = vec8.length;
        var result8 = realloc0(0, 0, 4, len8 * 4);
        for (let i = 0; i < vec8.length; i++) {
          const e = vec8[i];
          const base = result8 + i * 4;
          if (!(e instanceof WasmValue)) {
            throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
          }
          var handle7 = e[symbolRscHandle];
          if (!handle7) {
            const rep = e[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep, e);
            handle7 = rscTableCreateOwn(handleTable2, rep);
          }
          
          dataView(memory0).setInt32(base + 0, handle7, true);
        }
        dataView(memory0).setUint32(arg2 + 12, len8, true);
        dataView(memory0).setUint32(arg2 + 8, result8, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant9.tag)}\` (received \`${variant9}\`) specified for \`Event\``);
      }
    }
    
    break;
  }
  case 'err': {
    const e = variant11.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val10 = e;
    let enum10;
    switch (val10) {
      case 'invalid-entity': {
        enum10 = 0;
        break;
      }
      case 'invalid-pc': {
        enum10 = 1;
        break;
      }
      case 'invalid-frame': {
        enum10 = 2;
        break;
      }
      case 'unsupported-type': {
        enum10 = 3;
        break;
      }
      case 'mismatched-type': {
        enum10 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum10 = 5;
        break;
      }
      case 'alloc-failure': {
        enum10 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum10 = 7;
        break;
      }
      case 'read-only': {
        enum10 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum10 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum10 = 10;
        break;
      }
      case 'execution-trap': {
        enum10 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val10}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum10, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant11, valueType: typeof variant11});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[static]event-future.finish"][Instruction::Return]', {
  funcName: '[static]event-future.finish',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline59.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#EventFuture.finish';

const _trampoline60 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Frame.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-locals"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getLocals',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getLocals(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant9 = ret;
switch (variant9.tag) {
  case 'ok': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    var vec7 = e;
    var len7 = vec7.length;
    var result7 = realloc0(0, 0, 4, len7 * 4);
    for (let i = 0; i < vec7.length; i++) {
      const e = vec7[i];
      const base = result7 + i * 4;
      if (!(e instanceof WasmValue)) {
        throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
      }
      var handle6 = e[symbolRscHandle];
      if (!handle6) {
        const rep = e[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, e);
        handle6 = rscTableCreateOwn(handleTable2, rep);
      }
      
      dataView(memory0).setInt32(base + 0, handle6, true);
    }
    dataView(memory0).setUint32(arg2 + 8, len7, true);
    dataView(memory0).setUint32(arg2 + 4, result7, true);
    
    break;
  }
  case 'err': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val8 = e;
    let enum8;
    switch (val8) {
      case 'invalid-entity': {
        enum8 = 0;
        break;
      }
      case 'invalid-pc': {
        enum8 = 1;
        break;
      }
      case 'invalid-frame': {
        enum8 = 2;
        break;
      }
      case 'unsupported-type': {
        enum8 = 3;
        break;
      }
      case 'mismatched-type': {
        enum8 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum8 = 5;
        break;
      }
      case 'alloc-failure': {
        enum8 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum8 = 7;
        break;
      }
      case 'read-only': {
        enum8 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum8 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum8 = 10;
        break;
      }
      case 'execution-trap': {
        enum8 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val8}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum8, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant9, valueType: typeof variant9});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-locals"][Instruction::Return]', {
  funcName: '[method]frame.get-locals',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline60.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getLocals';

const _trampoline61 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Frame.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.parent-frame"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'parentFrame',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.parentFrame(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant9 = ret;
switch (variant9.tag) {
  case 'ok': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    var variant7 = e;
    if (variant7 === null || variant7=== undefined) {
      dataView(memory0).setInt8(arg2 + 4, 0, true);
    } else {
      const e = variant7;
      dataView(memory0).setInt8(arg2 + 4, 1, true);
      
      if (!(e instanceof Frame)) {
        throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
      }
      var handle6 = e[symbolRscHandle];
      if (!handle6) {
        const rep = e[symbolRscRep] || ++captureCnt3;
        captureTable3.set(rep, e);
        handle6 = rscTableCreateOwn(handleTable3, rep);
      }
      
      dataView(memory0).setInt32(arg2 + 8, handle6, true);
    }
    
    break;
  }
  case 'err': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val8 = e;
    let enum8;
    switch (val8) {
      case 'invalid-entity': {
        enum8 = 0;
        break;
      }
      case 'invalid-pc': {
        enum8 = 1;
        break;
      }
      case 'invalid-frame': {
        enum8 = 2;
        break;
      }
      case 'unsupported-type': {
        enum8 = 3;
        break;
      }
      case 'mismatched-type': {
        enum8 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum8 = 5;
        break;
      }
      case 'alloc-failure': {
        enum8 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum8 = 7;
        break;
      }
      case 'read-only': {
        enum8 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum8 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum8 = 10;
        break;
      }
      case 'execution-trap': {
        enum8 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val8}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum8, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant9, valueType: typeof variant9});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.parent-frame"][Instruction::Return]', {
  funcName: '[method]frame.parent-frame',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline61.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#parentFrame';

const _trampoline62 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Frame.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-pc"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getPc',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getPc(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant7 = ret;
switch (variant7.tag) {
  case 'ok': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    dataView(memory0).setInt32(arg2 + 4, toUint32(e), true);
    
    break;
  }
  case 'err': {
    const e = variant7.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val6 = e;
    let enum6;
    switch (val6) {
      case 'invalid-entity': {
        enum6 = 0;
        break;
      }
      case 'invalid-pc': {
        enum6 = 1;
        break;
      }
      case 'invalid-frame': {
        enum6 = 2;
        break;
      }
      case 'unsupported-type': {
        enum6 = 3;
        break;
      }
      case 'mismatched-type': {
        enum6 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum6 = 5;
        break;
      }
      case 'alloc-failure': {
        enum6 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum6 = 7;
        break;
      }
      case 'read-only': {
        enum6 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum6 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum6 = 10;
        break;
      }
      case 'execution-trap': {
        enum6 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val6}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum6, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-pc"][Instruction::Return]', {
  funcName: '[method]frame.get-pc',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline62.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getPc';

const _trampoline63 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Frame.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-stack"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getStack',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getStack(rsc3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant9 = ret;
switch (variant9.tag) {
  case 'ok': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    var vec7 = e;
    var len7 = vec7.length;
    var result7 = realloc0(0, 0, 4, len7 * 4);
    for (let i = 0; i < vec7.length; i++) {
      const e = vec7[i];
      const base = result7 + i * 4;
      if (!(e instanceof WasmValue)) {
        throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
      }
      var handle6 = e[symbolRscHandle];
      if (!handle6) {
        const rep = e[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, e);
        handle6 = rscTableCreateOwn(handleTable2, rep);
      }
      
      dataView(memory0).setInt32(base + 0, handle6, true);
    }
    dataView(memory0).setUint32(arg2 + 8, len7, true);
    dataView(memory0).setUint32(arg2 + 4, result7, true);
    
    break;
  }
  case 'err': {
    const e = variant9.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val8 = e;
    let enum8;
    switch (val8) {
      case 'invalid-entity': {
        enum8 = 0;
        break;
      }
      case 'invalid-pc': {
        enum8 = 1;
        break;
      }
      case 'invalid-frame': {
        enum8 = 2;
        break;
      }
      case 'unsupported-type': {
        enum8 = 3;
        break;
      }
      case 'mismatched-type': {
        enum8 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum8 = 5;
        break;
      }
      case 'alloc-failure': {
        enum8 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum8 = 7;
        break;
      }
      case 'read-only': {
        enum8 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum8 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum8 = 10;
        break;
      }
      case 'execution-trap': {
        enum8 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val8}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum8, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant9, valueType: typeof variant9});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]frame.get-stack"][Instruction::Return]', {
  funcName: '[method]frame.get-stack',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline63.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getStack';

const _trampoline64 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable7.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Module.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.bytecode"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'bytecode',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.bytecode(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var variant4 = ret;
  if (variant4 === null || variant4=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant4;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
    var ptr3 = realloc0(0, 0, 1, len3 * 1);
    
    let valData3;
    const valLenBytes3 = len3 * 1;
    if (Array.isArray(val3)) {
      // Regular array likely containing numbers, write values to memory
      let offset = 0;
      const dv3 = new DataView(memory0.buffer);
      for (const v of val3) {
        _requireValidNumericPrimitive.bind(null, 'u8')(v);
        dv3.setUint8(ptr3+ offset, v, true);
        offset += 1;
      }
    } else {
      // TypedArray / ArrayBuffer-like, direct copy
      valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
      const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
      out3.set(valData3);
    }
    
    dataView(memory0).setUint32(arg1 + 8, len3, true);
    dataView(memory0).setUint32(arg1 + 4, ptr3, true);
  }
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]module.bytecode"][Instruction::Return]', {
    funcName: '[method]module.bytecode',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline64.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#bytecode';

const _trampoline65 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.all-modules"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'allModules',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.allModules(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var vec4 = ret;
  var len4 = vec4.length;
  var result4 = realloc0(0, 0, 4, len4 * 4);
  for (let i = 0; i < vec4.length; i++) {
    const e = vec4[i];
    const base = result4 + i * 4;
    if (!(e instanceof Module)) {
      throw new TypeError('Resource error: Not a valid \"Module\" resource.');
    }
    var handle3 = e[symbolRscHandle];
    if (!handle3) {
      const rep = e[symbolRscRep] || ++captureCnt7;
      captureTable7.set(rep, e);
      handle3 = rscTableCreateOwn(handleTable7, rep);
    }
    
    dataView(memory0).setInt32(base + 0, handle3, true);
  }
  dataView(memory0).setUint32(arg1 + 4, len4, true);
  dataView(memory0).setUint32(arg1 + 0, result4, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.all-modules"][Instruction::Return]', {
    funcName: '[method]debuggee.all-modules',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline65.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#allModules';

const _trampoline66 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.exit-frames"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'exitFrames',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.exitFrames(arg1 >>> 0),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var vec4 = ret;
  var len4 = vec4.length;
  var result4 = realloc0(0, 0, 4, len4 * 4);
  for (let i = 0; i < vec4.length; i++) {
    const e = vec4[i];
    const base = result4 + i * 4;
    if (!(e instanceof Frame)) {
      throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
    }
    var handle3 = e[symbolRscHandle];
    if (!handle3) {
      const rep = e[symbolRscRep] || ++captureCnt3;
      captureTable3.set(rep, e);
      handle3 = rscTableCreateOwn(handleTable3, rep);
    }
    
    dataView(memory0).setInt32(base + 0, handle3, true);
  }
  dataView(memory0).setUint32(arg2 + 4, len4, true);
  dataView(memory0).setUint32(arg2 + 0, result4, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.exit-frames"][Instruction::Return]', {
    funcName: '[method]debuggee.exit-frames',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline66.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#exitFrames';

const handleTable10 = [T_FLAG, 0];
handleTable10._createdReps = new Set();


const captureTable10= new Map();
let captureCnt10= 0;

HANDLE_TABLES[10] = handleTable10;

const _trampoline67 = function(arg0, arg1, arg2, arg3, arg4, arg5) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  let variant17;
  switch (arg2) {
    case 0: {
      variant17= {
        tag: 'normal',
      };
      break;
    }
    case 1: {
      var handle4 = arg3;
      
      var rep5 = handleTable10[(handle4 << 1) + 1] & ~T_FLAG;
      var rsc3 = captureTable10.get(rep5);
      if (!rsc3) {
        rsc3 = Object.create(WasmFunc.prototype);
        Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
        Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
      }
      
      else {
        captureTable10.delete(rep5);
      }
      rscTableRemove(handleTable10, handle4);
      var len9 = arg5;
      var base9 = arg4;
      var result9 = [];
      for (let i = 0; i < len9; i++) {
        const base = base9 + i * 4;
        var handle7 = dataView(memory0).getInt32(base + 0, true);
        
        var rep8 = handleTable2[(handle7 << 1) + 1] & ~T_FLAG;
        var rsc6 = captureTable2.get(rep8);
        if (!rsc6) {
          rsc6 = Object.create(WasmValue.prototype);
          Object.defineProperty(rsc6, symbolRscHandle, { writable: true, value: handle7});
          Object.defineProperty(rsc6, symbolRscRep, { writable: true, value: rep8});
        }
        
        else {
          captureTable2.delete(rep8);
        }
        rscTableRemove(handleTable2, handle7);
        result9.push(rsc6);
      }
      variant17= {
        tag: 'inject-call',
        val: {
          callee: rsc3,
          arguments: result9,
        }
      };
      break;
    }
    case 2: {
      var handle11 = arg3;
      
      var rep12 = handleTable1[(handle11 << 1) + 1] & ~T_FLAG;
      var rsc10 = captureTable1.get(rep12);
      if (!rsc10) {
        rsc10 = Object.create(WasmException.prototype);
        Object.defineProperty(rsc10, symbolRscHandle, { writable: true, value: handle11});
        Object.defineProperty(rsc10, symbolRscRep, { writable: true, value: rep12});
      }
      
      else {
        captureTable1.delete(rep12);
      }
      rscTableRemove(handleTable1, handle11);
      variant17= {
        tag: 'throw-exception',
        val: rsc10
      };
      break;
    }
    case 3: {
      var len16 = arg4;
      var base16 = arg3;
      var result16 = [];
      for (let i = 0; i < len16; i++) {
        const base = base16 + i * 4;
        var handle14 = dataView(memory0).getInt32(base + 0, true);
        
        var rep15 = handleTable2[(handle14 << 1) + 1] & ~T_FLAG;
        var rsc13 = captureTable2.get(rep15);
        if (!rsc13) {
          rsc13 = Object.create(WasmValue.prototype);
          Object.defineProperty(rsc13, symbolRscHandle, { writable: true, value: handle14});
          Object.defineProperty(rsc13, symbolRscRep, { writable: true, value: rep15});
        }
        
        else {
          captureTable2.delete(rep15);
        }
        rscTableRemove(handleTable2, handle14);
        result16.push(rsc13);
      }
      variant17= {
        tag: 'early-return',
        val: result16
      };
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for ResumptionValue');
    }
  }
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.single-step"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'singleStep',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.singleStep(arg1 >>> 0, variant17),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  
  if (!(ret instanceof EventFuture)) {
    throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
  }
  var handle18 = ret[symbolRscHandle];
  if (!handle18) {
    const rep = ret[symbolRscRep] || ++captureCnt9;
    captureTable9.set(rep, ret);
    handle18 = rscTableCreateOwn(handleTable9, rep);
  }
  
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.single-step"][Instruction::Return]', {
    funcName: '[method]debuggee.single-step',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  task.resolve([handle18]);
  task.exit();
  return handle18;
}
_trampoline67.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#singleStep';

const _trampoline68 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.all-instances"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'allInstances',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.allInstances(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var vec4 = ret;
  var len4 = vec4.length;
  var result4 = realloc0(0, 0, 4, len4 * 4);
  for (let i = 0; i < vec4.length; i++) {
    const e = vec4[i];
    const base = result4 + i * 4;
    if (!(e instanceof Instance)) {
      throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
    }
    var handle3 = e[symbolRscHandle];
    if (!handle3) {
      const rep = e[symbolRscRep] || ++captureCnt5;
      captureTable5.set(rep, e);
      handle3 = rscTableCreateOwn(handleTable5, rep);
    }
    
    dataView(memory0).setInt32(base + 0, handle3, true);
  }
  dataView(memory0).setUint32(arg1 + 4, len4, true);
  dataView(memory0).setUint32(arg1 + 0, result4, true);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.all-instances"][Instruction::Return]', {
    funcName: '[method]debuggee.all-instances',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline68.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#allInstances';

const _trampoline69 = function(arg0, arg1, arg2, arg3, arg4) {
  var handle1 = arg0;
  
  var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable4.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  let variant17;
  switch (arg1) {
    case 0: {
      variant17= {
        tag: 'normal',
      };
      break;
    }
    case 1: {
      var handle4 = arg2;
      
      var rep5 = handleTable10[(handle4 << 1) + 1] & ~T_FLAG;
      var rsc3 = captureTable10.get(rep5);
      if (!rsc3) {
        rsc3 = Object.create(WasmFunc.prototype);
        Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
        Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
      }
      
      else {
        captureTable10.delete(rep5);
      }
      rscTableRemove(handleTable10, handle4);
      var len9 = arg4;
      var base9 = arg3;
      var result9 = [];
      for (let i = 0; i < len9; i++) {
        const base = base9 + i * 4;
        var handle7 = dataView(memory0).getInt32(base + 0, true);
        
        var rep8 = handleTable2[(handle7 << 1) + 1] & ~T_FLAG;
        var rsc6 = captureTable2.get(rep8);
        if (!rsc6) {
          rsc6 = Object.create(WasmValue.prototype);
          Object.defineProperty(rsc6, symbolRscHandle, { writable: true, value: handle7});
          Object.defineProperty(rsc6, symbolRscRep, { writable: true, value: rep8});
        }
        
        else {
          captureTable2.delete(rep8);
        }
        rscTableRemove(handleTable2, handle7);
        result9.push(rsc6);
      }
      variant17= {
        tag: 'inject-call',
        val: {
          callee: rsc3,
          arguments: result9,
        }
      };
      break;
    }
    case 2: {
      var handle11 = arg2;
      
      var rep12 = handleTable1[(handle11 << 1) + 1] & ~T_FLAG;
      var rsc10 = captureTable1.get(rep12);
      if (!rsc10) {
        rsc10 = Object.create(WasmException.prototype);
        Object.defineProperty(rsc10, symbolRscHandle, { writable: true, value: handle11});
        Object.defineProperty(rsc10, symbolRscRep, { writable: true, value: rep12});
      }
      
      else {
        captureTable1.delete(rep12);
      }
      rscTableRemove(handleTable1, handle11);
      variant17= {
        tag: 'throw-exception',
        val: rsc10
      };
      break;
    }
    case 3: {
      var len16 = arg3;
      var base16 = arg2;
      var result16 = [];
      for (let i = 0; i < len16; i++) {
        const base = base16 + i * 4;
        var handle14 = dataView(memory0).getInt32(base + 0, true);
        
        var rep15 = handleTable2[(handle14 << 1) + 1] & ~T_FLAG;
        var rsc13 = captureTable2.get(rep15);
        if (!rsc13) {
          rsc13 = Object.create(WasmValue.prototype);
          Object.defineProperty(rsc13, symbolRscHandle, { writable: true, value: handle14});
          Object.defineProperty(rsc13, symbolRscRep, { writable: true, value: rep15});
        }
        
        else {
          captureTable2.delete(rep15);
        }
        rscTableRemove(handleTable2, handle14);
        result16.push(rsc13);
      }
      variant17= {
        tag: 'early-return',
        val: result16
      };
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for ResumptionValue');
    }
  }
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.continue"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'continue',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.continue(variant17),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  
  if (!(ret instanceof EventFuture)) {
    throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
  }
  var handle18 = ret[symbolRscHandle];
  if (!handle18) {
    const rep = ret[symbolRscRep] || ++captureCnt9;
    captureTable9.set(rep, ret);
    handle18 = rscTableCreateOwn(handleTable9, rep);
  }
  
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]debuggee.continue"][Instruction::Return]', {
    funcName: '[method]debuggee.continue',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  task.resolve([handle18]);
  task.exit();
  return handle18;
}
_trampoline69.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#continue';

const _trampoline70 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable5[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable5.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Instance.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var handle4 = arg1;
  
  var rep5 = handleTable4[(handle4 << 1) + 1] & ~T_FLAG;
  var rsc3 = captureTable4.get(rep5);
  if (!rsc3) {
    rsc3 = Object.create(Debuggee.prototype);
    Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
    Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
  }
  
  curResourceBorrows.push(rsc3);
  _debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-memory"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getMemory',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.getMemory(rsc3, arg2 >>> 0),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant8 = ret;
switch (variant8.tag) {
  case 'ok': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    if (!(e instanceof Memory)) {
      throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
    }
    var handle6 = e[symbolRscHandle];
    if (!handle6) {
      const rep = e[symbolRscRep] || ++captureCnt8;
      captureTable8.set(rep, e);
      handle6 = rscTableCreateOwn(handleTable8, rep);
    }
    
    dataView(memory0).setInt32(arg3 + 4, handle6, true);
    
    break;
  }
  case 'err': {
    const e = variant8.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var val7 = e;
    let enum7;
    switch (val7) {
      case 'invalid-entity': {
        enum7 = 0;
        break;
      }
      case 'invalid-pc': {
        enum7 = 1;
        break;
      }
      case 'invalid-frame': {
        enum7 = 2;
        break;
      }
      case 'unsupported-type': {
        enum7 = 3;
        break;
      }
      case 'mismatched-type': {
        enum7 = 4;
        break;
      }
      case 'non-wasm-frame': {
        enum7 = 5;
        break;
      }
      case 'alloc-failure': {
        enum7 = 6;
        break;
      }
      case 'breakpoint-update': {
        enum7 = 7;
        break;
      }
      case 'read-only': {
        enum7 = 8;
        break;
      }
      case 'out-of-bounds': {
        enum7 = 9;
        break;
      }
      case 'memory-grow-failure': {
        enum7 = 10;
        break;
      }
      case 'execution-trap': {
        enum7 = 11;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val7}" is not one of the cases of error`);
      }
    }
    dataView(memory0).setInt8(arg3 + 4, enum7, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="bytecodealliance:wasmtime/debuggee@44.0.0", function="[method]instance.get-memory"][Instruction::Return]', {
  funcName: '[method]instance.get-memory',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline70.fnName = 'bytecodealliance:wasmtime/debuggee@44.0.0#getMemory';

const handleTable11 = [T_FLAG, 0];
handleTable11._createdReps = new Set();


const captureTable11= new Map();
let captureCnt11= 0;

HANDLE_TABLES[11] = handleTable11;

const _trampoline71 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable12[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable12.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(InputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.read"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'read',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.read(BigInt.asUintN(64, BigInt(arg1))),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant6 = ret;
switch (variant6.tag) {
  case 'ok': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    var val3 = e;
    var len3 = Array.isArray(val3) ? val3.length : val3.byteLength;
    var ptr3 = realloc0(0, 0, 1, len3 * 1);
    
    let valData3;
    const valLenBytes3 = len3 * 1;
    if (Array.isArray(val3)) {
      // Regular array likely containing numbers, write values to memory
      let offset = 0;
      const dv3 = new DataView(memory0.buffer);
      for (const v of val3) {
        _requireValidNumericPrimitive.bind(null, 'u8')(v);
        dv3.setUint8(ptr3+ offset, v, true);
        offset += 1;
      }
    } else {
      // TypedArray / ArrayBuffer-like, direct copy
      valData3 = new Uint8Array(val3.buffer || val3, val3.byteOffset, valLenBytes3);
      const out3 = new Uint8Array(memory0.buffer, ptr3, valLenBytes3);
      out3.set(valData3);
    }
    
    dataView(memory0).setUint32(arg2 + 8, len3, true);
    dataView(memory0).setUint32(arg2 + 4, ptr3, true);
    
    break;
  }
  case 'err': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var variant5 = e;
    switch (variant5.tag) {
      case 'last-operation-failed': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg2 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle4 = e[symbolRscHandle];
        if (!handle4) {
          const rep = e[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, e);
          handle4 = rscTableCreateOwn(handleTable11, rep);
        }
        
        dataView(memory0).setInt32(arg2 + 8, handle4, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg2 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.read"][Instruction::Return]', {
  funcName: '[method]input-stream.read',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline71.fnName = 'wasi:io/streams@0.2.12#read';

const _trampoline72 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable13[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable13.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.check-write"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'checkWrite',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.checkWrite(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    dataView(memory0).setBigInt64(arg1 + 8, toUint64(e), true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var variant4 = e;
    switch (variant4.tag) {
      case 'last-operation-failed': {
        const e = variant4.val;
        dataView(memory0).setInt8(arg1 + 8, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle3 = e[symbolRscHandle];
        if (!handle3) {
          const rep = e[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, e);
          handle3 = rscTableCreateOwn(handleTable11, rep);
        }
        
        dataView(memory0).setInt32(arg1 + 12, handle3, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg1 + 8, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant4.tag)}\` (received \`${variant4}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.check-write"][Instruction::Return]', {
  funcName: '[method]output-stream.check-write',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline72.fnName = 'wasi:io/streams@0.2.12#checkWrite';

const _trampoline73 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable13[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable13.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.write"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'write',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.write(result3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant6 = ret;
switch (variant6.tag) {
  case 'ok': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var variant5 = e;
    switch (variant5.tag) {
      case 'last-operation-failed': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg3 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle4 = e[symbolRscHandle];
        if (!handle4) {
          const rep = e[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, e);
          handle4 = rscTableCreateOwn(handleTable11, rep);
        }
        
        dataView(memory0).setInt32(arg3 + 8, handle4, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg3 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.write"][Instruction::Return]', {
  funcName: '[method]output-stream.write',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline73.fnName = 'wasi:io/streams@0.2.12#write';

const _trampoline74 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable11[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable11.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Error$1.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/error@0.2.12", function="[method]error.to-debug-string"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'toDebugString',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.toDebugString(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  
  var encodeRes = _utf8AllocateAndEncode(ret, realloc0, memory0);
  var ptr3= encodeRes.ptr;
  var len3 = encodeRes.len;
  
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="wasi:io/error@0.2.12", function="[method]error.to-debug-string"][Instruction::Return]', {
    funcName: '[method]error.to-debug-string',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline74.fnName = 'wasi:io/error@0.2.12#toDebugString';

const _trampoline75 = function(arg0, arg1, arg2) {
  var len3 = arg1;
  var base3 = arg0;
  var result3 = [];
  for (let i = 0; i < len3; i++) {
    const base = base3 + i * 4;
    var handle1 = dataView(memory0).getInt32(base + 0, true);
    
    var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable0.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Pollable.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    result3.push(rsc0);
  }
  _debugLog('[iface="wasi:io/poll@0.2.12", function="poll"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'poll',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => poll(result3),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var val4 = ret;
  var len4 = val4.length;
  var ptr4 = realloc0(0, 0, 4, len4 * 4);
  
  let valData4;
  const valLenBytes4 = len4 * 4;
  if (Array.isArray(val4)) {
    // Regular array likely containing numbers, write values to memory
    let offset = 0;
    const dv4 = new DataView(memory0.buffer);
    for (const v of val4) {
      _requireValidNumericPrimitive.bind(null, 'u32')(v);
      dv4.setUint32(ptr4+ offset, v, true);
      offset += 4;
    }
  } else {
    // TypedArray / ArrayBuffer-like, direct copy
    valData4 = new Uint8Array(val4.buffer || val4, val4.byteOffset, valLenBytes4);
    const out4 = new Uint8Array(memory0.buffer, ptr4, valLenBytes4);
    out4.set(valData4);
  }
  
  dataView(memory0).setUint32(arg2 + 4, len4, true);
  dataView(memory0).setUint32(arg2 + 0, ptr4, true);
  _debugLog('[iface="wasi:io/poll@0.2.12", function="poll"][Instruction::Return]', {
    funcName: 'poll',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline75.fnName = 'wasi:io/poll@0.2.12#poll';

const _trampoline76 = function(arg0, arg1) {
  let enum0;
  switch (arg0) {
    case 0: {
      enum0 = 'ipv4';
      break;
    }
    case 1: {
      enum0 = 'ipv6';
      break;
    }
    default: {
      throw new TypeError('invalid discriminant specified for IpAddressFamily');
    }
  }
  _debugLog('[iface="wasi:sockets/tcp-create-socket@0.2.12", function="create-tcp-socket"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'createTcpSocket',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => createTcpSocket(enum0),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

var variant3 = ret;
switch (variant3.tag) {
  case 'ok': {
    const e = variant3.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    if (!(e instanceof TcpSocket)) {
      throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
    }
    var handle1 = e[symbolRscHandle];
    if (!handle1) {
      const rep = e[symbolRscRep] || ++captureCnt17;
      captureTable17.set(rep, e);
      handle1 = rscTableCreateOwn(handleTable17, rep);
    }
    
    dataView(memory0).setInt32(arg1 + 4, handle1, true);
    
    break;
  }
  case 'err': {
    const e = variant3.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val2 = e;
    let enum2;
    switch (val2) {
      case 'unknown': {
        enum2 = 0;
        break;
      }
      case 'access-denied': {
        enum2 = 1;
        break;
      }
      case 'not-supported': {
        enum2 = 2;
        break;
      }
      case 'invalid-argument': {
        enum2 = 3;
        break;
      }
      case 'out-of-memory': {
        enum2 = 4;
        break;
      }
      case 'timeout': {
        enum2 = 5;
        break;
      }
      case 'concurrency-conflict': {
        enum2 = 6;
        break;
      }
      case 'not-in-progress': {
        enum2 = 7;
        break;
      }
      case 'would-block': {
        enum2 = 8;
        break;
      }
      case 'invalid-state': {
        enum2 = 9;
        break;
      }
      case 'new-socket-limit': {
        enum2 = 10;
        break;
      }
      case 'address-not-bindable': {
        enum2 = 11;
        break;
      }
      case 'address-in-use': {
        enum2 = 12;
        break;
      }
      case 'remote-unreachable': {
        enum2 = 13;
        break;
      }
      case 'connection-refused': {
        enum2 = 14;
        break;
      }
      case 'connection-reset': {
        enum2 = 15;
        break;
      }
      case 'connection-aborted': {
        enum2 = 16;
        break;
      }
      case 'datagram-too-large': {
        enum2 = 17;
        break;
      }
      case 'name-unresolvable': {
        enum2 = 18;
        break;
      }
      case 'temporary-resolver-failure': {
        enum2 = 19;
        break;
      }
      case 'permanent-resolver-failure': {
        enum2 = 20;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val2}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 4, enum2, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant3, valueType: typeof variant3});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:sockets/tcp-create-socket@0.2.12", function="create-tcp-socket"][Instruction::Return]', {
  funcName: 'create-tcp-socket',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline76.fnName = 'wasi:sockets/tcp-create-socket@0.2.12#createTcpSocket';

const _trampoline77 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable13[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable13.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'blockingWriteAndFlush',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.blockingWriteAndFlush(result3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant6 = ret;
switch (variant6.tag) {
  case 'ok': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var variant5 = e;
    switch (variant5.tag) {
      case 'last-operation-failed': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg3 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle4 = e[symbolRscHandle];
        if (!handle4) {
          const rep = e[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, e);
          handle4 = rscTableCreateOwn(handleTable11, rep);
        }
        
        dataView(memory0).setInt32(arg3 + 8, handle4, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg3 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-write-and-flush"][Instruction::Return]', {
  funcName: '[method]output-stream.blocking-write-and-flush',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline77.fnName = 'wasi:io/streams@0.2.12#blockingWriteAndFlush';

const _trampoline78 = function(arg0) {
  _debugLog('[iface="wasi:random/insecure-seed@0.2.12", function="insecure-seed"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'insecureSeed',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => insecureSeed(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var [tuple0_0, tuple0_1] = ret;
  dataView(memory0).setBigInt64(arg0 + 0, toUint64(tuple0_0), true);
  dataView(memory0).setBigInt64(arg0 + 8, toUint64(tuple0_1), true);
  _debugLog('[iface="wasi:random/insecure-seed@0.2.12", function="insecure-seed"][Instruction::Return]', {
    funcName: 'insecure-seed',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline78.fnName = 'wasi:random/insecure-seed@0.2.12#insecureSeed';

const _trampoline79 = function(arg0) {
  _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-environment"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getEnvironment',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getEnvironment(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var vec3 = ret;
  var len3 = vec3.length;
  var result3 = realloc0(0, 0, 4, len3 * 16);
  for (let i = 0; i < vec3.length; i++) {
    const e = vec3[i];
    const base = result3 + i * 16;var [tuple0_0, tuple0_1] = e;
    
    var encodeRes = _utf8AllocateAndEncode(tuple0_0, realloc0, memory0);
    var ptr1= encodeRes.ptr;
    var len1 = encodeRes.len;
    
    dataView(memory0).setUint32(base + 4, len1, true);
    dataView(memory0).setUint32(base + 0, ptr1, true);
    
    var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
    var ptr2= encodeRes.ptr;
    var len2 = encodeRes.len;
    
    dataView(memory0).setUint32(base + 12, len2, true);
    dataView(memory0).setUint32(base + 8, ptr2, true);
  }
  dataView(memory0).setUint32(arg0 + 4, len3, true);
  dataView(memory0).setUint32(arg0 + 0, result3, true);
  _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-environment"][Instruction::Return]', {
    funcName: 'get-environment',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline79.fnName = 'wasi:cli/environment@0.2.12#getEnvironment';

const handleTable14 = [T_FLAG, 0];
handleTable14._createdReps = new Set();


const captureTable14= new Map();
let captureCnt14= 0;

HANDLE_TABLES[14] = handleTable14;

const _trampoline80 = function(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stdin@0.2.12", function="get-terminal-stdin"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getTerminalStdin',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getTerminalStdin(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    
    if (!(e instanceof TerminalInput)) {
      throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt14;
      captureTable14.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable14, rep);
    }
    
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stdin@0.2.12", function="get-terminal-stdin"][Instruction::Return]', {
    funcName: 'get-terminal-stdin',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline80.fnName = 'wasi:cli/terminal-stdin@0.2.12#getTerminalStdin';

const handleTable15 = [T_FLAG, 0];
handleTable15._createdReps = new Set();


const captureTable15= new Map();
let captureCnt15= 0;

HANDLE_TABLES[15] = handleTable15;

const _trampoline81 = function(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stdout@0.2.12", function="get-terminal-stdout"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getTerminalStdout',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getTerminalStdout(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    
    if (!(e instanceof TerminalOutput)) {
      throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt15;
      captureTable15.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable15, rep);
    }
    
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stdout@0.2.12", function="get-terminal-stdout"][Instruction::Return]', {
    funcName: 'get-terminal-stdout',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline81.fnName = 'wasi:cli/terminal-stdout@0.2.12#getTerminalStdout';

const _trampoline82 = function(arg0) {
  _debugLog('[iface="wasi:cli/terminal-stderr@0.2.12", function="get-terminal-stderr"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getTerminalStderr',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getTerminalStderr(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: currentSubtask?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var variant1 = ret;
  if (variant1 === null || variant1=== undefined) {
    dataView(memory0).setInt8(arg0 + 0, 0, true);
  } else {
    const e = variant1;
    dataView(memory0).setInt8(arg0 + 0, 1, true);
    
    if (!(e instanceof TerminalOutput)) {
      throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
    }
    var handle0 = e[symbolRscHandle];
    if (!handle0) {
      const rep = e[symbolRscRep] || ++captureCnt15;
      captureTable15.set(rep, e);
      handle0 = rscTableCreateOwn(handleTable15, rep);
    }
    
    dataView(memory0).setInt32(arg0 + 4, handle0, true);
  }
  _debugLog('[iface="wasi:cli/terminal-stderr@0.2.12", function="get-terminal-stderr"][Instruction::Return]', {
    funcName: 'get-terminal-stderr',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline82.fnName = 'wasi:cli/terminal-stderr@0.2.12#getTerminalStderr';
let exports2;
let debugger4400Debug;

function debug(arg0, arg1) {
  
  if (!(arg0 instanceof Debuggee)) {
    throw new TypeError('Resource error: Not a valid \"Debuggee\" resource.');
  }
  var handle0 = arg0[symbolRscHandle];
  if (!handle0) {
    const rep = arg0[symbolRscRep] || ++captureCnt4;
    captureTable4.set(rep, arg0);
    handle0 = rscTableCreateBorrow(handleTable4, rep, SCOPE_ID);
  }
  
  var vec2 = arg1;
  var len2 = vec2.length;
  var result2 = realloc0(0, 0, 4, len2 * 8);
  for (let i = 0; i < vec2.length; i++) {
    const e = vec2[i];
    const base = result2 + i * 8;
    var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
    var ptr1= encodeRes.ptr;
    var len1 = encodeRes.len;
    
    dataView(memory0).setUint32(base + 4, len1, true);
    dataView(memory0).setUint32(base + 0, ptr1, true);
  }
  _debugLog('[iface="bytecodealliance:wasmtime/debugger@44.0.0", function="debug"][Instruction::CallWasm] enter', {
    funcName: 'debug',
    paramCount: 3,
    async: false,
    postReturn: false,
  });
  const hostProvided = false;
  
  const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
    componentIdx: 0,
    isAsync: false,
    isManualAsync: false,
    entryFnName: 'debugger4400Debug',
    getCallbackFn: () => null,
    callbackFnName: null,
    errHandling: 'none',
    callingWasmExport: true,
  });
  
  const started = task.enterSync();
  
  if (0!== null) {
    task.setReturnMemoryIdx(0);
    task.setReturnMemory(() => memory0());
  }
  
  
  let ret;
  
  try {
    _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => debugger4400Debug(handle0, result2, len2),
    });
  } catch (err) {
    
    _debugLog('[Instruction::CallWasm] error during sync call', {
      taskID: task.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  _debugLog('[iface="bytecodealliance:wasmtime/debugger@44.0.0", function="debug"][Instruction::Return]', {
    funcName: 'debug',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
function trampoline0(handle) {
  const handleEntry = rscTableRemove(handleTable16, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable16.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable16.delete(handleEntry.rep);
    } else if (Network[symbolCabiDispose]) {
      Network[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline1(handle) {
  const handleEntry = rscTableRemove(handleTable17, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable17.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable17.delete(handleEntry.rep);
    } else if (TcpSocket[symbolCabiDispose]) {
      TcpSocket[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline2(handle) {
  const handleEntry = rscTableRemove(handleTable1, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable1.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable1.delete(handleEntry.rep);
    } else if (WasmException[symbolCabiDispose]) {
      WasmException[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline3(handle) {
  const handleEntry = rscTableRemove(handleTable13, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable13.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable13.delete(handleEntry.rep);
    } else if (OutputStream[symbolCabiDispose]) {
      OutputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline4 = _trampoline4.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 4,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline4.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_WasmValue(obj) {
      if (!(obj instanceof WasmValue)) {
        throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, obj);
        handle = rscTableCreateOwn(handleTable2, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline4,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 4,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline4.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_WasmValue(obj) {
      if (!(obj instanceof WasmValue)) {
        throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, obj);
        handle = rscTableCreateOwn(handleTable2, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline4,
},
);
function trampoline5(handle) {
  const handleEntry = rscTableRemove(handleTable2, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable2.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable2.delete(handleEntry.rep);
    } else if (WasmValue[symbolCabiDispose]) {
      WasmValue[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline6(handle) {
  const handleEntry = rscTableRemove(handleTable6, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable6.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable6.delete(handleEntry.rep);
    } else if (Global[symbolCabiDispose]) {
      Global[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline7(handle) {
  const handleEntry = rscTableRemove(handleTable5, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable5.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable5.delete(handleEntry.rep);
    } else if (Instance[symbolCabiDispose]) {
      Instance[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline8(handle) {
  const handleEntry = rscTableRemove(handleTable3, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable3.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable3.delete(handleEntry.rep);
    } else if (Frame[symbolCabiDispose]) {
      Frame[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 9,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline9.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatU32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline9,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 9,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline9.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatU32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline9,
},
);
let trampoline10 = _trampoline10.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 10,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline10.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatU32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline10,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 10,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline10.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatU32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline10,
},
);
let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 11,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline11.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline11,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 11,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline11.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline11,
},
);
let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 12,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline12.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatFloat32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline12,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 12,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline12.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatFloat32],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline12,
},
);
let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 13,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline13.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatFloat64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline13,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 13,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline13.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatFloat64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline13,
},
);
function trampoline14(handle) {
  const handleEntry = rscTableRemove(handleTable9, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable9.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable9.delete(handleEntry.rep);
    } else if (EventFuture[symbolCabiDispose]) {
      EventFuture[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline15 = _trampoline15.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 15,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline15.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline15,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 15,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline15.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline15,
},
);
let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 16,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline16.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Memory(obj) {
      if (!(obj instanceof Memory)) {
        throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt8;
        captureTable8.set(rep, obj);
        handle = rscTableCreateOwn(handleTable8, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline16,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 16,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline16.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Memory(obj) {
      if (!(obj instanceof Memory)) {
        throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt8;
        captureTable8.set(rep, obj);
        handle = rscTableCreateOwn(handleTable8, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline16,
},
);
let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 17,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline17.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline17,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 17,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline17.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline17,
},
);
let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 18,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline18.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Module(obj) {
      if (!(obj instanceof Module)) {
        throw new TypeError('Resource error: Not a valid \"Module\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, obj);
        handle = rscTableCreateOwn(handleTable7, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline18,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 18,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline18.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Module(obj) {
      if (!(obj instanceof Module)) {
        throw new TypeError('Resource error: Not a valid \"Module\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, obj);
        handle = rscTableCreateOwn(handleTable7, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline18,
},
);
let trampoline19 = _trampoline19.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 19,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline19.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline19,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 19,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline19.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline19,
},
);
let trampoline20 = _trampoline20.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 20,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline20.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Module(obj) {
      if (!(obj instanceof Module)) {
        throw new TypeError('Resource error: Not a valid \"Module\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, obj);
        handle = rscTableCreateOwn(handleTable7, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline20,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 20,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline20.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Module(obj) {
      if (!(obj instanceof Module)) {
        throw new TypeError('Resource error: Not a valid \"Module\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt7;
        captureTable7.set(rep, obj);
        handle = rscTableCreateOwn(handleTable7, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline20,
},
);
let trampoline21 = _trampoline21.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 21,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline21.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatVariant({
    caseMetas: [[ 'wasm-i32', null, 0, 0, 0 ],[ 'wasm-i64', null, 0, 0, 0 ],[ 'wasm-f32', null, 0, 0, 0 ],[ 'wasm-f64', null, 0, 0, 0 ],[ 'wasm-v128', null, 0, 0, 0 ],[ 'wasm-funcref', null, 0, 0, 0 ],[ 'wasm-exnref', null, 0, 0, 0 ],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  } )],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline21,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 21,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline21.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatVariant({
    caseMetas: [[ 'wasm-i32', null, 0, 0, 0 ],[ 'wasm-i64', null, 0, 0, 0 ],[ 'wasm-f32', null, 0, 0, 0 ],[ 'wasm-f64', null, 0, 0, 0 ],[ 'wasm-v128', null, 0, 0, 0 ],[ 'wasm-funcref', null, 0, 0, 0 ],[ 'wasm-exnref', null, 0, 0, 0 ],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  } )],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline21,
},
);
function trampoline22(handle) {
  const handleEntry = rscTableRemove(handleTable4, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable4.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable4.delete(handleEntry.rep);
    } else if (Debuggee[symbolCabiDispose]) {
      Debuggee[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline23(handle) {
  const handleEntry = rscTableRemove(handleTable10, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable10.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable10.delete(handleEntry.rep);
    } else if (WasmFunc[symbolCabiDispose]) {
      WasmFunc[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline24(handle) {
  const handleEntry = rscTableRemove(handleTable8, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable8.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable8.delete(handleEntry.rep);
    } else if (Memory[symbolCabiDispose]) {
      Memory[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline25(handle) {
  const handleEntry = rscTableRemove(handleTable7, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable7.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable7.delete(handleEntry.rep);
    } else if (Module[symbolCabiDispose]) {
      Module[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline26(handle) {
  const handleEntry = rscTableRemove(handleTable12, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable12.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable12.delete(handleEntry.rep);
    } else if (InputStream[symbolCabiDispose]) {
      InputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline27(handle) {
  const handleEntry = rscTableRemove(handleTable11, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable11.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable11.delete(handleEntry.rep);
    } else if (Error$1[symbolCabiDispose]) {
      Error$1[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline28 = _trampoline28.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 28,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline28.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline28,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 28,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline28.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline28,
},
);
function trampoline29(handle) {
  const handleEntry = rscTableRemove(handleTable0, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable0.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable0.delete(handleEntry.rep);
    } else if (Pollable[symbolCabiDispose]) {
      Pollable[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline30 = _trampoline30.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 30,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline30.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 12)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline30,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 30,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline30.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 12)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline30,
},
);
let trampoline31 = _trampoline31.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 31,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline31.manuallyAsync,
  paramLiftFns: [_liftFlatU64],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline31,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 31,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline31.manuallyAsync,
  paramLiftFns: [_liftFlatU64],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline31,
},
);
let trampoline32 = _trampoline32.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 32,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline32.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
  resultLowerFns: [_lowerFlatBool],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline32,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 32,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline32.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
  resultLowerFns: [_lowerFlatBool],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline32,
},
);
let trampoline33 = _trampoline33.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 33,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline33.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Network(obj) {
      if (!(obj instanceof Network)) {
        throw new TypeError('Resource error: Not a valid \"Network\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt16;
        captureTable16.set(rep, obj);
        handle = rscTableCreateOwn(handleTable16, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline33,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 33,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline33.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Network(obj) {
      if (!(obj instanceof Network)) {
        throw new TypeError('Resource error: Not a valid \"Network\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt16;
        captureTable16.set(rep, obj);
        handle = rscTableCreateOwn(handleTable16, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline33,
},
);
let trampoline34 = _trampoline34.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 34,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline34.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline34,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 34,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline34.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_Pollable(obj) {
      if (!(obj instanceof Pollable)) {
        throw new TypeError('Resource error: Not a valid \"Pollable\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt0;
        captureTable0.set(rep, obj);
        handle = rscTableCreateOwn(handleTable0, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline34,
},
);
let trampoline35 = _trampoline35.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 35,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline35.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt13;
        captureTable13.set(rep, obj);
        handle = rscTableCreateOwn(handleTable13, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline35,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 35,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline35.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt13;
        captureTable13.set(rep, obj);
        handle = rscTableCreateOwn(handleTable13, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline35,
},
);
let trampoline36 = _trampoline36.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 36,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline36.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt13;
        captureTable13.set(rep, obj);
        handle = rscTableCreateOwn(handleTable13, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline36,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 36,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline36.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt13;
        captureTable13.set(rep, obj);
        handle = rscTableCreateOwn(handleTable13, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline36,
},
);
function trampoline37(handle) {
  const handleEntry = rscTableRemove(handleTable14, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable14.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable14.delete(handleEntry.rep);
    } else if (TerminalInput[symbolCabiDispose]) {
      TerminalInput[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline38(handle) {
  const handleEntry = rscTableRemove(handleTable15, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable15.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable15.delete(handleEntry.rep);
    } else if (TerminalOutput[symbolCabiDispose]) {
      TerminalOutput[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline39 = _trampoline39.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 39,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline39.manuallyAsync,
  paramLiftFns: [
  _liftFlatResult({
    caseMetas: [['ok', null, 0, 0, 0],['err', null, 0, 0, 0],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline39,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 39,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline39.manuallyAsync,
  paramLiftFns: [
  _liftFlatResult({
    caseMetas: [['ok', null, 0, 0, 0],['err', null, 0, 0, 0],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline39,
},
);
let trampoline40 = _trampoline40.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 40,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline40.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_InputStream(obj) {
      if (!(obj instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt12;
        captureTable12.set(rep, obj);
        handle = rscTableCreateOwn(handleTable12, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline40,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 40,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline40.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_InputStream(obj) {
      if (!(obj instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt12;
        captureTable12.set(rep, obj);
        handle = rscTableCreateOwn(handleTable12, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline40,
},
);
let trampoline41 = _trampoline41.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 41,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline41.manuallyAsync,
  paramLiftFns: [_liftFlatStringAny],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline41,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 41,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline41.manuallyAsync,
  paramLiftFns: [_liftFlatStringAny],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline41,
},
);
let trampoline42 = _trampoline42.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 42,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline42.manuallyAsync,
  paramLiftFns: [_liftFlatStringAny],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline42,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 42,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline42.manuallyAsync,
  paramLiftFns: [_liftFlatStringAny],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline42,
},
);
let trampoline43 = _trampoline43.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 43,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline43.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17),_liftFlatBorrow.bind(null, 16),_liftFlatVariant({
    caseMetas: [['ipv4', _liftFlatRecord({ fieldMetas: [['port', _liftFlatU16, 2, 2],['address', _liftFlatTuple({ elemLiftFns: [[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],], size32: 4, align32: 1 }), 4, 1],], size32: 6, align32: 2 }), 6, 2, 5],['ipv6', _liftFlatRecord({ fieldMetas: [['port', _liftFlatU16, 2, 2],['flowInfo', _liftFlatU32, 4, 4],['address', _liftFlatTuple({ elemLiftFns: [[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],], size32: 16, align32: 2 }), 16, 2],['scopeId', _liftFlatU32, 4, 4],], size32: 28, align32: 4 }), 28, 4, 11],],
    variantSize32: 32,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 12,
  } )],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline43,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 43,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline43.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17),_liftFlatBorrow.bind(null, 16),_liftFlatVariant({
    caseMetas: [['ipv4', _liftFlatRecord({ fieldMetas: [['port', _liftFlatU16, 2, 2],['address', _liftFlatTuple({ elemLiftFns: [[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],[_liftFlatU8, 1, 1],], size32: 4, align32: 1 }), 4, 1],], size32: 6, align32: 2 }), 6, 2, 5],['ipv6', _liftFlatRecord({ fieldMetas: [['port', _liftFlatU16, 2, 2],['flowInfo', _liftFlatU32, 4, 4],['address', _liftFlatTuple({ elemLiftFns: [[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],[_liftFlatU16, 2, 2],], size32: 16, align32: 2 }), 16, 2],['scopeId', _liftFlatU32, 4, 4],], size32: 28, align32: 4 }), 28, 4, 11],],
    variantSize32: 32,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 12,
  } )],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline43,
},
);
let trampoline44 = _trampoline44.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 44,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline44.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline44,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 44,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline44.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline44,
},
);
let trampoline45 = _trampoline45.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 45,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline45.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline45,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 45,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline45.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline45,
},
);
let trampoline46 = _trampoline46.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 46,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline46.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline46,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 46,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline46.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline46,
},
);
let trampoline47 = _trampoline47.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 47,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline47.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatVariant({
      caseMetas: [[ 'ipv4', _lowerFlatRecord({ fieldMetas: [['port', _lowerFlatU16, 2, 2 ],['address', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],], size32: 4, align32: 1 }), 4, 1 ],], size32: 6, align32: 2 }), 6, 2, 5 ],[ 'ipv6', _lowerFlatRecord({ fieldMetas: [['port', _lowerFlatU16, 2, 2 ],['flowInfo', _lowerFlatU32, 4, 4 ],['address', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],], size32: 16, align32: 2 }), 16, 2 ],['scopeId', _lowerFlatU32, 4, 4 ],], size32: 28, align32: 4 }), 28, 4, 11 ],],
      variantSize32: 32,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 12,
    } ), 36, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 36, 4, 4 ],
    ],
    variantSize32: 36,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 13,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline47,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 47,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline47.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatVariant({
      caseMetas: [[ 'ipv4', _lowerFlatRecord({ fieldMetas: [['port', _lowerFlatU16, 2, 2 ],['address', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],[_lowerFlatU8, 1, 1],], size32: 4, align32: 1 }), 4, 1 ],], size32: 6, align32: 2 }), 6, 2, 5 ],[ 'ipv6', _lowerFlatRecord({ fieldMetas: [['port', _lowerFlatU16, 2, 2 ],['flowInfo', _lowerFlatU32, 4, 4 ],['address', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],[_lowerFlatU16, 2, 2],], size32: 16, align32: 2 }), 16, 2 ],['scopeId', _lowerFlatU32, 4, 4 ],], size32: 28, align32: 4 }), 28, 4, 11 ],],
      variantSize32: 32,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 12,
    } ), 36, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 36, 4, 4 ],
    ],
    variantSize32: 36,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 13,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline47,
},
);
let trampoline48 = _trampoline48.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 48,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline48.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TcpSocket(obj) {
        if (!(obj instanceof TcpSocket)) {
          throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_InputStream(obj) {
        if (!(obj instanceof InputStream)) {
          throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt12;
          captureTable12.set(rep, obj);
          handle = rscTableCreateOwn(handleTable12, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt13;
          captureTable13.set(rep, obj);
          handle = rscTableCreateOwn(handleTable13, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],], size32: 12, align32: 4 }), 16, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 16, 4, 4 ],
    ],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline48,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 48,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline48.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TcpSocket(obj) {
        if (!(obj instanceof TcpSocket)) {
          throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_InputStream(obj) {
        if (!(obj instanceof InputStream)) {
          throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt12;
          captureTable12.set(rep, obj);
          handle = rscTableCreateOwn(handleTable12, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt13;
          captureTable13.set(rep, obj);
          handle = rscTableCreateOwn(handleTable13, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],], size32: 12, align32: 4 }), 16, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 16, 4, 4 ],
    ],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline48,
},
);
let trampoline49 = _trampoline49.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 49,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline49.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17),
  _liftFlatEnum({
    caseMetas: [['receive', null, 1, 1, 1],['send', null, 1, 1, 1],['both', null, 1, 1, 1],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline49,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 49,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline49.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 17),
  _liftFlatEnum({
    caseMetas: [['receive', null, 1, 1, 1],['send', null, 1, 1, 1],['both', null, 1, 1, 1],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline49,
},
);
let trampoline50 = _trampoline50.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 50,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline50.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Instance(obj) {
        if (!(obj instanceof Instance)) {
          throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline50,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 50,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline50.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Instance(obj) {
        if (!(obj instanceof Instance)) {
          throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline50,
},
);
let trampoline51 = _trampoline51.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 51,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline51.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Global(obj) {
        if (!(obj instanceof Global)) {
          throw new TypeError('Resource error: Not a valid \"Global\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt6;
          captureTable6.set(rep, obj);
          handle = rscTableCreateOwn(handleTable6, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline51,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 51,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline51.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Global(obj) {
        if (!(obj instanceof Global)) {
          throw new TypeError('Resource error: Not a valid \"Global\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt6;
          captureTable6.set(rep, obj);
          handle = rscTableCreateOwn(handleTable6, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline51,
},
);
let trampoline52 = _trampoline52.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 52,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline52.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 6),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_WasmValue(obj) {
        if (!(obj instanceof WasmValue)) {
          throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt2;
          captureTable2.set(rep, obj);
          handle = rscTableCreateOwn(handleTable2, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline52,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 52,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline52.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 6),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_WasmValue(obj) {
        if (!(obj instanceof WasmValue)) {
          throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt2;
          captureTable2.set(rep, obj);
          handle = rscTableCreateOwn(handleTable2, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline52,
},
);
let trampoline53 = _trampoline53.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 53,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline53.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatStringAny],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline53,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 53,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline53.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [_lowerFlatStringAny],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline53,
},
);
let trampoline54 = _trampoline54.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 54,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline54.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline54,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 54,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline54.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline54,
},
);
let trampoline55 = _trampoline55.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 55,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline55.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline55,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 55,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline55.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline55,
},
);
let trampoline56 = _trampoline56.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 56,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline56.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8),_liftFlatBorrow.bind(null, 4),_liftFlatU64,_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline56,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 56,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline56.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 8),_liftFlatBorrow.bind(null, 4),_liftFlatU64,_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline56,
},
);
let trampoline57 = _trampoline57.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 57,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline57.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU32,
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline57,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 57,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline57.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU32,
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline57,
},
);
let trampoline58 = _trampoline58.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 58,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline58.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU8,
    elemSize32: 1,
    elemAlign32: 1,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline58,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 58,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline58.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU8,
    elemSize32: 1,
    elemAlign32: 1,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline58,
},
);
let trampoline59 = _trampoline59.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 59,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline59.manuallyAsync,
  paramLiftFns: [_liftFlatOwn({
    componentIdx: 0,
    className: EventFuture,
    createResourceFn: 
    (handle) => {
      const rep = handleTable9[(handle << 1) + 1] & ~T_FLAG;
      let resourceObj = captureTable9.get(rep);
      if (!resourceObj) {
        resourceObj = Object.create(EventFuture.prototype);
        Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
        Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
      } else {
        captureTable9.delete(rep);
      }
      rscTableRemove(handleTable9, handle);
      return resourceObj;
    }
    ,
  })
  ,_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatVariant({
      caseMetas: [[ 'complete', null, 0, 0, 0 ],[ 'trap', null, 0, 0, 0 ],[ 'breakpoint', null, 0, 0, 0 ],[ 'interrupted', null, 0, 0, 0 ],[ 'exception', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmException(obj) {
          if (!(obj instanceof WasmException)) {
            throw new TypeError('Resource error: Not a valid \"WasmException\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, obj);
            handle = rscTableCreateOwn(handleTable1, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'injected-call-return', _lowerFlatList({
        elemLowerFn: _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_WasmValue(obj) {
            if (!(obj instanceof WasmValue)) {
              throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep, obj);
              handle = rscTableCreateOwn(handleTable2, rep);
            }
            return handle;
          }
          ,
        }),
        elemSize32: 4,
        elemAlign32: 4,
      }), 8, 4, 2 ],],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    } ), 16, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 16, 4, 4 ],
    ],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline59,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 59,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline59.manuallyAsync,
  paramLiftFns: [_liftFlatOwn({
    componentIdx: 0,
    className: EventFuture,
    createResourceFn: 
    (handle) => {
      const rep = handleTable9[(handle << 1) + 1] & ~T_FLAG;
      let resourceObj = captureTable9.get(rep);
      if (!resourceObj) {
        resourceObj = Object.create(EventFuture.prototype);
        Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
        Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
      } else {
        captureTable9.delete(rep);
      }
      rscTableRemove(handleTable9, handle);
      return resourceObj;
    }
    ,
  })
  ,_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatVariant({
      caseMetas: [[ 'complete', null, 0, 0, 0 ],[ 'trap', null, 0, 0, 0 ],[ 'breakpoint', null, 0, 0, 0 ],[ 'interrupted', null, 0, 0, 0 ],[ 'exception', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmException(obj) {
          if (!(obj instanceof WasmException)) {
            throw new TypeError('Resource error: Not a valid \"WasmException\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, obj);
            handle = rscTableCreateOwn(handleTable1, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'injected-call-return', _lowerFlatList({
        elemLowerFn: _lowerFlatOwn({
          componentIdx: 0,
          lowerFn: 
          function lowerImportedOwnedHost_WasmValue(obj) {
            if (!(obj instanceof WasmValue)) {
              throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep, obj);
              handle = rscTableCreateOwn(handleTable2, rep);
            }
            return handle;
          }
          ,
        }),
        elemSize32: 4,
        elemAlign32: 4,
      }), 8, 4, 2 ],],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
    } ), 16, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 16, 4, 4 ],
    ],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline59,
},
);
let trampoline60 = _trampoline60.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 60,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline60.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmValue(obj) {
          if (!(obj instanceof WasmValue)) {
            throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep, obj);
            handle = rscTableCreateOwn(handleTable2, rep);
          }
          return handle;
        }
        ,
      }),
      elemSize32: 4,
      elemAlign32: 4,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline60,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 60,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline60.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmValue(obj) {
          if (!(obj instanceof WasmValue)) {
            throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep, obj);
            handle = rscTableCreateOwn(handleTable2, rep);
          }
          return handle;
        }
        ,
      }),
      elemSize32: 4,
      elemAlign32: 4,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline60,
},
);
let trampoline61 = _trampoline61.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 61,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline61.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Frame(obj) {
          if (!(obj instanceof Frame)) {
            throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt3;
            captureTable3.set(rep, obj);
            handle = rscTableCreateOwn(handleTable3, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    , 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline61,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 61,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline61.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Frame(obj) {
          if (!(obj instanceof Frame)) {
            throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt3;
            captureTable3.set(rep, obj);
            handle = rscTableCreateOwn(handleTable3, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    , 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline61,
},
);
let trampoline62 = _trampoline62.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 62,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline62.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU32, 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline62,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 62,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline62.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU32, 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline62,
},
);
let trampoline63 = _trampoline63.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 63,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline63.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmValue(obj) {
          if (!(obj instanceof WasmValue)) {
            throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep, obj);
            handle = rscTableCreateOwn(handleTable2, rep);
          }
          return handle;
        }
        ,
      }),
      elemSize32: 4,
      elemAlign32: 4,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline63,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 63,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline63.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_WasmValue(obj) {
          if (!(obj instanceof WasmValue)) {
            throw new TypeError('Resource error: Not a valid \"WasmValue\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep, obj);
            handle = rscTableCreateOwn(handleTable2, rep);
          }
          return handle;
        }
        ,
      }),
      elemSize32: 4,
      elemAlign32: 4,
    }), 12, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline63,
},
);
let trampoline64 = _trampoline64.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 64,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline64.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 8, 4, 2],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline64,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 64,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline64.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 8, 4, 2],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline64,
},
);
let trampoline65 = _trampoline65.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 65,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline65.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Module(obj) {
        if (!(obj instanceof Module)) {
          throw new TypeError('Resource error: Not a valid \"Module\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt7;
          captureTable7.set(rep, obj);
          handle = rscTableCreateOwn(handleTable7, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline65,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 65,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline65.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Module(obj) {
        if (!(obj instanceof Module)) {
          throw new TypeError('Resource error: Not a valid \"Module\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt7;
          captureTable7.set(rep, obj);
          handle = rscTableCreateOwn(handleTable7, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline65,
},
);
let trampoline66 = _trampoline66.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 66,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline66.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Frame(obj) {
        if (!(obj instanceof Frame)) {
          throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline66,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 66,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline66.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Frame(obj) {
        if (!(obj instanceof Frame)) {
          throw new TypeError('Resource error: Not a valid \"Frame\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline66,
},
);
let trampoline67 = _trampoline67.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 67,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline67.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatU32,_liftFlatVariant({
    caseMetas: [['normal', null, 0, 0, 0],['inject-call', _liftFlatRecord({ fieldMetas: [['callee', _liftFlatOwn({
      componentIdx: 0,
      className: WasmFunc,
      createResourceFn: 
      (handle) => {
        const rep = handleTable10[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable10.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmFunc.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable10.delete(rep);
        }
        rscTableRemove(handleTable10, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4],['arguments', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4],], size32: 12, align32: 4 }), 12, 4, 3],['throw-exception', _liftFlatOwn({
      componentIdx: 0,
      className: WasmException,
      createResourceFn: 
      (handle) => {
        const rep = handleTable1[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable1.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmException.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable1.delete(rep);
        }
        rscTableRemove(handleTable1, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4, 1],['early-return', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4, 2],],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  } )],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_EventFuture(obj) {
      if (!(obj instanceof EventFuture)) {
        throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, obj);
        handle = rscTableCreateOwn(handleTable9, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline67,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 67,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline67.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatU32,_liftFlatVariant({
    caseMetas: [['normal', null, 0, 0, 0],['inject-call', _liftFlatRecord({ fieldMetas: [['callee', _liftFlatOwn({
      componentIdx: 0,
      className: WasmFunc,
      createResourceFn: 
      (handle) => {
        const rep = handleTable10[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable10.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmFunc.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable10.delete(rep);
        }
        rscTableRemove(handleTable10, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4],['arguments', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4],], size32: 12, align32: 4 }), 12, 4, 3],['throw-exception', _liftFlatOwn({
      componentIdx: 0,
      className: WasmException,
      createResourceFn: 
      (handle) => {
        const rep = handleTable1[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable1.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmException.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable1.delete(rep);
        }
        rscTableRemove(handleTable1, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4, 1],['early-return', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4, 2],],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  } )],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_EventFuture(obj) {
      if (!(obj instanceof EventFuture)) {
        throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, obj);
        handle = rscTableCreateOwn(handleTable9, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline67,
},
);
let trampoline68 = _trampoline68.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 68,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline68.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Instance(obj) {
        if (!(obj instanceof Instance)) {
          throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline68,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 68,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline68.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4)],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Instance(obj) {
        if (!(obj instanceof Instance)) {
          throw new TypeError('Resource error: Not a valid \"Instance\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    }),
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline68,
},
);
let trampoline69 = _trampoline69.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 69,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline69.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatVariant({
    caseMetas: [['normal', null, 0, 0, 0],['inject-call', _liftFlatRecord({ fieldMetas: [['callee', _liftFlatOwn({
      componentIdx: 0,
      className: WasmFunc,
      createResourceFn: 
      (handle) => {
        const rep = handleTable10[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable10.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmFunc.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable10.delete(rep);
        }
        rscTableRemove(handleTable10, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4],['arguments', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4],], size32: 12, align32: 4 }), 12, 4, 3],['throw-exception', _liftFlatOwn({
      componentIdx: 0,
      className: WasmException,
      createResourceFn: 
      (handle) => {
        const rep = handleTable1[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable1.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmException.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable1.delete(rep);
        }
        rscTableRemove(handleTable1, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4, 1],['early-return', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4, 2],],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  } )],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_EventFuture(obj) {
      if (!(obj instanceof EventFuture)) {
        throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, obj);
        handle = rscTableCreateOwn(handleTable9, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline69,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 69,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline69.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatVariant({
    caseMetas: [['normal', null, 0, 0, 0],['inject-call', _liftFlatRecord({ fieldMetas: [['callee', _liftFlatOwn({
      componentIdx: 0,
      className: WasmFunc,
      createResourceFn: 
      (handle) => {
        const rep = handleTable10[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable10.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmFunc.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable10.delete(rep);
        }
        rscTableRemove(handleTable10, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4],['arguments', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4],], size32: 12, align32: 4 }), 12, 4, 3],['throw-exception', _liftFlatOwn({
      componentIdx: 0,
      className: WasmException,
      createResourceFn: 
      (handle) => {
        const rep = handleTable1[(handle << 1) + 1] & ~T_FLAG;
        let resourceObj = captureTable1.get(rep);
        if (!resourceObj) {
          resourceObj = Object.create(WasmException.prototype);
          Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
          Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
        } else {
          captureTable1.delete(rep);
        }
        rscTableRemove(handleTable1, handle);
        return resourceObj;
      }
      ,
    })
    , 4, 4, 1],['early-return', _liftFlatList({
      elemLiftFn: _liftFlatOwn({
        componentIdx: 0,
        className: WasmValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable2.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(WasmValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable2.delete(rep);
          }
          rscTableRemove(handleTable2, handle);
          return resourceObj;
        }
        ,
      })
      ,
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    }), 8, 4, 2],],
    variantSize32: 16,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 4,
  } )],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_EventFuture(obj) {
      if (!(obj instanceof EventFuture)) {
        throw new TypeError('Resource error: Not a valid \"EventFuture\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt9;
        captureTable9.set(rep, obj);
        handle = rscTableCreateOwn(handleTable9, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline69,
},
);
let trampoline70 = _trampoline70.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 70,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline70.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Memory(obj) {
        if (!(obj instanceof Memory)) {
          throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt8;
          captureTable8.set(rep, obj);
          handle = rscTableCreateOwn(handleTable8, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline70,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 70,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline70.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 5),_liftFlatBorrow.bind(null, 4),_liftFlatU32],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Memory(obj) {
        if (!(obj instanceof Memory)) {
          throw new TypeError('Resource error: Not a valid \"Memory\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt8;
          captureTable8.set(rep, obj);
          handle = rscTableCreateOwn(handleTable8, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['invalid-entity', null, 1, 1, 1],['invalid-pc', null, 1, 1, 1],['invalid-frame', null, 1, 1, 1],['unsupported-type', null, 1, 1, 1],['mismatched-type', null, 1, 1, 1],['non-wasm-frame', null, 1, 1, 1],['alloc-failure', null, 1, 1, 1],['breakpoint-update', null, 1, 1, 1],['read-only', null, 1, 1, 1],['out-of-bounds', null, 1, 1, 1],['memory-grow-failure', null, 1, 1, 1],['execution-trap', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline70,
},
);
let trampoline71 = _trampoline71.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 71,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline71.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 12),_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline71,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 71,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline71.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 12),_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatList({
      elemLowerFn: _lowerFlatU8,
      elemSize32: 1,
      elemAlign32: 1,
    }), 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline71,
},
);
let trampoline72 = _trampoline72.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 72,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline72.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU64, 16, 8, 8 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 16, 8, 8 ],
    ],
    variantSize32: 16,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline72,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 72,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline72.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU64, 16, 8, 8 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 16, 8, 8 ],
    ],
    variantSize32: 16,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline72,
},
);
let trampoline73 = _trampoline73.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 73,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline73.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline73,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 73,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline73.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline73,
},
);
let trampoline74 = _trampoline74.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 74,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline74.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 11)],
  resultLowerFns: [_lowerFlatStringAny],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline74,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 74,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline74.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 11)],
  resultLowerFns: [_lowerFlatStringAny],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline74,
},
);
let trampoline75 = _trampoline75.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 75,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline75.manuallyAsync,
  paramLiftFns: [_liftFlatList({
    elemLiftFn: _liftFlatBorrow.bind(null, 0),
    elemAlign32: 4,
    elemSize32: 4,
    typedArray: undefined,
  })],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU32,
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline75,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 75,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline75.manuallyAsync,
  paramLiftFns: [_liftFlatList({
    elemLiftFn: _liftFlatBorrow.bind(null, 0),
    elemAlign32: 4,
    elemSize32: 4,
    typedArray: undefined,
  })],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU32,
    elemSize32: 4,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline75,
},
);
let trampoline76 = _trampoline76.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 76,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline76.manuallyAsync,
  paramLiftFns: [
  _liftFlatEnum({
    caseMetas: [['ipv4', null, 1, 1, 1],['ipv6', null, 1, 1, 1],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TcpSocket(obj) {
        if (!(obj instanceof TcpSocket)) {
          throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline76,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 76,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline76.manuallyAsync,
  paramLiftFns: [
  _liftFlatEnum({
    caseMetas: [['ipv4', null, 1, 1, 1],['ipv6', null, 1, 1, 1],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TcpSocket(obj) {
        if (!(obj instanceof TcpSocket)) {
          throw new TypeError('Resource error: Not a valid \"TcpSocket\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['access-denied', null, 1, 1, 1],['not-supported', null, 1, 1, 1],['invalid-argument', null, 1, 1, 1],['out-of-memory', null, 1, 1, 1],['timeout', null, 1, 1, 1],['concurrency-conflict', null, 1, 1, 1],['not-in-progress', null, 1, 1, 1],['would-block', null, 1, 1, 1],['invalid-state', null, 1, 1, 1],['new-socket-limit', null, 1, 1, 1],['address-not-bindable', null, 1, 1, 1],['address-in-use', null, 1, 1, 1],['remote-unreachable', null, 1, 1, 1],['connection-refused', null, 1, 1, 1],['connection-reset', null, 1, 1, 1],['connection-aborted', null, 1, 1, 1],['datagram-too-large', null, 1, 1, 1],['name-unresolvable', null, 1, 1, 1],['temporary-resolver-failure', null, 1, 1, 1],['permanent-resolver-failure', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline76,
},
);
let trampoline77 = _trampoline77.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 77,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline77.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline77,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 77,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline77.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 13),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt11;
            captureTable11.set(rep, obj);
            handle = rscTableCreateOwn(handleTable11, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline77,
},
);
let trampoline78 = _trampoline78.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 78,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline78.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU64, 8, 8],[_lowerFlatU64, 8, 8],], size32: 16, align32: 8 })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline78,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 78,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline78.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatTuple({ elemLowerMetas: [[_lowerFlatU64, 8, 8],[_lowerFlatU64, 8, 8],], size32: 16, align32: 8 })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline78,
},
);
let trampoline79 = _trampoline79.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 79,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline79.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
    elemSize32: 16,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline79,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 79,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline79.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
    elemSize32: 16,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline79,
},
);
let trampoline80 = _trampoline80.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 80,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline80.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalInput(obj) {
        if (!(obj instanceof TerminalInput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt14;
          captureTable14.set(rep, obj);
          handle = rscTableCreateOwn(handleTable14, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline80,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 80,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline80.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalInput(obj) {
        if (!(obj instanceof TerminalInput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalInput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt14;
          captureTable14.set(rep, obj);
          handle = rscTableCreateOwn(handleTable14, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline80,
},
);
let trampoline81 = _trampoline81.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 81,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline81.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalOutput(obj) {
        if (!(obj instanceof TerminalOutput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline81,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 81,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline81.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalOutput(obj) {
        if (!(obj instanceof TerminalOutput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline81,
},
);
let trampoline82 = _trampoline82.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 82,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline82.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalOutput(obj) {
        if (!(obj instanceof TerminalOutput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline82,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 82,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline82.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_TerminalOutput(obj) {
        if (!(obj instanceof TerminalOutput)) {
          throw new TypeError('Resource error: Not a valid \"TerminalOutput\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    }), 4, 4, 1],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline82,
},
);
Promise.all([module0, module1, module2]).catch(() => {});
({ exports: exports0 } = yield instantiateCore(yield module1));
({ exports: exports1 } = yield instantiateCore(yield module0, {
  $root: {
    'log-line': exports0['1'],
    'print-debugger-info': exports0['0'],
  },
  'bytecodealliance:wasmtime/debuggee@44.0.0': {
    '[method]debuggee.all-instances': exports0['27'],
    '[method]debuggee.all-modules': exports0['24'],
    '[method]debuggee.continue': exports0['28'],
    '[method]debuggee.exit-frames': exports0['25'],
    '[method]debuggee.list-threads': exports0['16'],
    '[method]debuggee.single-step': exports0['26'],
    '[method]debuggee.stopped-thread': trampoline9,
    '[method]frame.get-instance': exports0['9'],
    '[method]frame.get-locals': exports0['19'],
    '[method]frame.get-pc': exports0['21'],
    '[method]frame.get-stack': exports0['22'],
    '[method]frame.parent-frame': exports0['20'],
    '[method]global.get': exports0['11'],
    '[method]instance.get-global': exports0['10'],
    '[method]instance.get-memory': exports0['29'],
    '[method]instance.get-module': trampoline20,
    '[method]memory.clone': trampoline16,
    '[method]memory.get-bytes': exports0['15'],
    '[method]memory.size-bytes': trampoline15,
    '[method]memory.unique-id': trampoline17,
    '[method]module.add-breakpoint': exports0['13'],
    '[method]module.bytecode': exports0['23'],
    '[method]module.clone': trampoline18,
    '[method]module.name': exports0['12'],
    '[method]module.remove-breakpoint': exports0['14'],
    '[method]module.unique-id': trampoline19,
    '[method]wasm-value.clone': trampoline4,
    '[method]wasm-value.get-type': trampoline21,
    '[method]wasm-value.unwrap-f32': trampoline12,
    '[method]wasm-value.unwrap-f64': trampoline13,
    '[method]wasm-value.unwrap-i32': trampoline10,
    '[method]wasm-value.unwrap-i64': trampoline11,
    '[method]wasm-value.unwrap-v128': exports0['17'],
    '[resource-drop]debuggee': trampoline22,
    '[resource-drop]event-future': trampoline14,
    '[resource-drop]frame': trampoline8,
    '[resource-drop]global': trampoline6,
    '[resource-drop]instance': trampoline7,
    '[resource-drop]memory': trampoline24,
    '[resource-drop]module': trampoline25,
    '[resource-drop]wasm-exception': trampoline2,
    '[resource-drop]wasm-func': trampoline23,
    '[resource-drop]wasm-value': trampoline5,
    '[static]event-future.finish': exports0['18'],
  },
  'wasi:cli/environment@0.2.0': {
    'get-environment': exports0['38'],
  },
  'wasi:cli/exit@0.2.0': {
    exit: trampoline39,
  },
  'wasi:cli/stderr@0.2.0': {
    'get-stderr': trampoline35,
  },
  'wasi:cli/stderr@0.2.4': {
    'get-stderr': trampoline35,
  },
  'wasi:cli/stdin@0.2.0': {
    'get-stdin': trampoline40,
  },
  'wasi:cli/stdout@0.2.0': {
    'get-stdout': trampoline36,
  },
  'wasi:cli/stdout@0.2.4': {
    'get-stdout': trampoline36,
  },
  'wasi:cli/terminal-input@0.2.0': {
    '[resource-drop]terminal-input': trampoline37,
  },
  'wasi:cli/terminal-output@0.2.0': {
    '[resource-drop]terminal-output': trampoline38,
  },
  'wasi:cli/terminal-stderr@0.2.0': {
    'get-terminal-stderr': exports0['41'],
  },
  'wasi:cli/terminal-stdin@0.2.0': {
    'get-terminal-stdin': exports0['39'],
  },
  'wasi:cli/terminal-stdout@0.2.0': {
    'get-terminal-stdout': exports0['40'],
  },
  'wasi:clocks/monotonic-clock@0.2.12': {
    'subscribe-duration': trampoline31,
  },
  'wasi:io/error@0.2.12': {
    '[method]error.to-debug-string': exports0['33'],
    '[resource-drop]error': trampoline27,
  },
  'wasi:io/error@0.2.4': {
    '[method]error.to-debug-string': exports0['33'],
    '[resource-drop]error': trampoline27,
  },
  'wasi:io/poll@0.2.0': {
    '[resource-drop]pollable': trampoline29,
  },
  'wasi:io/poll@0.2.12': {
    '[method]pollable.ready': trampoline32,
    '[resource-drop]pollable': trampoline29,
    poll: exports0['34'],
  },
  'wasi:io/streams@0.2.0': {
    '[resource-drop]input-stream': trampoline26,
    '[resource-drop]output-stream': trampoline3,
  },
  'wasi:io/streams@0.2.12': {
    '[method]input-stream.read': exports0['30'],
    '[method]input-stream.subscribe': trampoline30,
    '[method]output-stream.check-write': exports0['31'],
    '[method]output-stream.subscribe': trampoline28,
    '[method]output-stream.write': exports0['32'],
    '[resource-drop]input-stream': trampoline26,
    '[resource-drop]output-stream': trampoline3,
  },
  'wasi:io/streams@0.2.4': {
    '[method]output-stream.blocking-write-and-flush': exports0['36'],
    '[resource-drop]output-stream': trampoline3,
  },
  'wasi:random/insecure-seed@0.2.4': {
    'insecure-seed': exports0['37'],
  },
  'wasi:sockets/instance-network@0.2.12': {
    'instance-network': trampoline33,
  },
  'wasi:sockets/network@0.2.12': {
    '[resource-drop]network': trampoline0,
  },
  'wasi:sockets/tcp-create-socket@0.2.12': {
    'create-tcp-socket': exports0['35'],
  },
  'wasi:sockets/tcp@0.2.12': {
    '[method]tcp-socket.accept': exports0['7'],
    '[method]tcp-socket.finish-bind': exports0['3'],
    '[method]tcp-socket.finish-listen': exports0['5'],
    '[method]tcp-socket.local-address': exports0['6'],
    '[method]tcp-socket.shutdown': exports0['8'],
    '[method]tcp-socket.start-bind': exports0['2'],
    '[method]tcp-socket.start-listen': exports0['4'],
    '[method]tcp-socket.subscribe': trampoline34,
    '[resource-drop]tcp-socket': trampoline1,
  },
}));
memory0 = exports1.memory;
realloc0 = exports1.cabi_realloc;

try {
  realloc0Async = WebAssembly.promising(exports1.cabi_realloc);
} catch(err) {
  realloc0Async = exports1.cabi_realloc;
}

({ exports: exports2 } = yield instantiateCore(yield module2, {
  '': {
    $imports: exports0.$imports,
    '0': trampoline41,
    '1': trampoline42,
    '10': trampoline51,
    '11': trampoline52,
    '12': trampoline53,
    '13': trampoline54,
    '14': trampoline55,
    '15': trampoline56,
    '16': trampoline57,
    '17': trampoline58,
    '18': trampoline59,
    '19': trampoline60,
    '2': trampoline43,
    '20': trampoline61,
    '21': trampoline62,
    '22': trampoline63,
    '23': trampoline64,
    '24': trampoline65,
    '25': trampoline66,
    '26': trampoline67,
    '27': trampoline68,
    '28': trampoline69,
    '29': trampoline70,
    '3': trampoline44,
    '30': trampoline71,
    '31': trampoline72,
    '32': trampoline73,
    '33': trampoline74,
    '34': trampoline75,
    '35': trampoline76,
    '36': trampoline77,
    '37': trampoline78,
    '38': trampoline79,
    '39': trampoline80,
    '4': trampoline45,
    '40': trampoline81,
    '41': trampoline82,
    '5': trampoline46,
    '6': trampoline47,
    '7': trampoline48,
    '8': trampoline49,
    '9': trampoline50,
  },
}));
debugger4400Debug = exports1['bytecodealliance:wasmtime/debugger@44.0.0#debug'];
const debugger4400 = {
  debug: debug,
  
};

return { 'debugger': debugger4400, 'bytecodealliance:wasmtime/debugger@44.0.0': debugger4400,  };
})();
let promise, resolve, reject;
function runNext (value) {
  try {
    let done;
    do {
      ({ value, done } = gen.next(value));
    } while (!(value instanceof Promise) && !done);
    if (done) {
      if (resolve) return resolve(value);
      else return value;
    }
    if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
    value.then(nextVal => done ? resolve() : runNext(nextVal), reject);
  }
  catch (e) {
    if (reject) reject(e);
    else throw e;
  }
}
const maybeSyncReturn = runNext(null);
return promise || maybeSyncReturn;
};

(module $plain
  (func $wat_factorial (export "wat_factorial") (param $n i32) (result i32)
    local.get $n
    i32.const 1
    i32.le_s
    if (result i32)
      i32.const 1
    else
      local.get $n
      local.get $n
      i32.const 1
      i32.sub
      call $wat_factorial
      i32.mul
    end
  )
)

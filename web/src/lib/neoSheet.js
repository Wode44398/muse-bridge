// vmx 浮层（模型选单/参数面板等 panel 内 sheet）的关闭注册表——
// 让 VertexPage 的系统返回 closer 能逐层关掉它们（vs.matMenu/matPicker 之外的新增浮层）。
// 组件挂载时 register(close) 拿到注销函数，卸载时调用。

const stack = [];

export function registerNeoSheet(close) {
  stack.push(close);
  return () => {
    const i = stack.indexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
}

// 关掉最顶层的 vmx 浮层；有关掉返回 true（VertexPage closer 据此吞掉这次返回）。
export function closeNeoSheet() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  try { top(); } catch {}
  return true;
}

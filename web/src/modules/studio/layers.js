// Studio 浮层（模型选择、参数、音色、添加素材、工作空间选图、任务托盘、作品菜单……）的返回栈。
// Studio 外壳注册的系统返回 closer（StudioPage 的 registerCloser('studio')）先问这里，逐层关掉最上面那层，
// 都关完了才收抽屉、再回主页。浮层挂载时 pushLayer(close) 拿到注销函数，卸载时调用。

const stack = [];

export function pushLayer(close) {
  stack.push(close);
  return () => {
    const i = stack.indexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
}

// 关掉最顶层的浮层；有关掉返回 true（Studio 的返回 closer 据此吞掉这次返回）。
export function closeTopLayer() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  try { top(); } catch {}
  return true;
}
export const layerCount = () => stack.length;

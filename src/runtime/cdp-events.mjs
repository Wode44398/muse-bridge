const MAX_NET = 400;

export function handleBrowserMessage(session, data) {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message.id != null && session.bPending.has(message.id)) {
    const pending = session.bPending.get(message.id);
    session.bPending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
    else pending.resolve(message.result);
    return;
  }
  const params = message.params;
  switch (message.method) {
    case 'Target.targetCreated': {
      const target = params?.targetInfo;
      // 共享无头宿主里同一个人别的工作空间的标签也会报上来，只认自己的；自己页面 window.open / target=_blank
      // 开出来的（openerId 是自己的标签）收养进来，否则弹窗成了谁都看不见的游离标签。
      if (target?.type === 'page' && target.targetId && session.sharedHost
          && target.openerId && session.ownedTargets.has(String(target.openerId))) {
        session.ownedTargets.add(String(target.targetId));
      }
      if (target?.type === 'page' && target.targetId
          && (!session.external || session.ownedTargets.has(String(target.targetId)))) {
        session.upsertTab({
          id: String(target.targetId),
          url: String(target.url ?? ''),
          title: String(target.title ?? ''),
          active: false,
        });
      }
      break;
    }
    case 'Target.targetInfoChanged': {
      const target = params?.targetInfo;
      if (target?.targetId) {
        const tab = session.tabs.find((item) => item.id === String(target.targetId));
        if (tab) {
          tab.url = String(target.url ?? tab.url);
          tab.title = String(target.title ?? tab.title);
          session.notifyTabs();
        }
      }
      break;
    }
    case 'Target.targetDestroyed':
      session.onTargetGone(String(params?.targetId ?? ''));
      break;
  }
}

export function handlePageMessage(session, data) {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message.id != null && session.pending.has(message.id)) {
    const pending = session.pending.get(message.id);
    session.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
    else pending.resolve(message.result);
    return;
  }
  const params = message.params;
  switch (message.method) {
    case 'Input.dragIntercepted':   // drag() 开了 setInterceptDrags：HTML5 拖放被接住，拿到拖拽数据
      session.onDragIntercepted?.(params);
      return;
    case 'Page.loadEventFired': {
      const waiters = session.loadWaiters;
      session.loadWaiters = [];
      for (const waiter of waiters) waiter();
      session.refreshTabsSoon?.();
      break;
    }
    case 'Page.frameNavigated':
      if (params?.frame && !params.frame.parentId) {
        session.mainFrameId = String(params.frame.id ?? '');
        session.navSeq = (session.navSeq || 0) + 1;
        session.url = params.frame.url;
        session.syncActiveTabUrl(session.url);
      }
      break;
    // 主框架是否正在加载：settle（等页面就绪）靠它判断「还在跳转中」。frameId 不认识时
    // （首次导航前还不知道主框架 id）也算——宁可多等一会儿，不要把半截页面当结果。
    case 'Page.frameStartedLoading':
      if (!session.mainFrameId || params?.frameId === session.mainFrameId) { session.loading = true; session.loadingSince = Date.now(); }
      break;
    case 'Page.frameStoppedLoading':
      if (!session.mainFrameId || params?.frameId === session.mainFrameId) session.loading = false;
      break;
    case 'Page.javascriptDialogOpening':
      session.onDialog?.(params);   // 不应答就会一直挡住页面主线程（见 CdpSession.onDialog）
      break;
    case 'Page.navigatedWithinDocument':
      if (params?.url) {
        session.url = params.url;
        session.syncActiveTabUrl(session.url);
      }
      break;
    case 'Page.screencastFrame': {
      session.send('Page.screencastFrameAck', { sessionId: params?.sessionId }).catch(() => {});
      const frame = {
        data: String(params?.data ?? ''),
        deviceWidth: Number(params?.metadata?.deviceWidth ?? session.viewport.width),
        deviceHeight: Number(params?.metadata?.deviceHeight ?? session.viewport.height),
        ts: Date.now(),
      };
      session.lastFrame = frame;
      for (const callback of session.castSubs) {
        try { callback(frame); } catch { /* subscriber's problem */ }
      }
      break;
    }
    case 'Runtime.consoleAPICalled': {
      const parts = (params?.args ?? []).map((argument) => {
        if (argument.value !== undefined) {
          return typeof argument.value === 'string' ? argument.value : safeJson(argument.value);
        }
        return argument.description ?? argument.type ?? '';
      });
      session.pushConsole(`console.${params?.type ?? 'log'}`, parts.join(' '));
      break;
    }
    case 'Runtime.exceptionThrown': {
      const details = params?.exceptionDetails;
      session.pushConsole(
        'error',
        String(details?.exception?.description || details?.text || 'uncaught exception'),
      );
      break;
    }
    case 'Log.entryAdded': {
      const entry = params?.entry;
      if (entry) {
        session.pushConsole(
          `${entry.source ?? 'log'}.${entry.level ?? 'info'}`,
          `${entry.text ?? ''}${entry.url ? ` (${entry.url})` : ''}`,
        );
      }
      break;
    }
    case 'Network.requestWillBeSent': {
      const id = String(params?.requestId ?? '');
      if (!id) break;
      let entry = session.netByReqId.get(id);
      if (entry) {
        entry.url = params.request?.url ?? entry.url;
      } else {
        entry = {
          id,
          t: Date.now(),
          method: params.request?.method ?? 'GET',
          url: params.request?.url ?? '',
          resourceType: params.type,
          size: 0,
          state: 'pending',
        };
        session.netByReqId.set(id, entry);
        session.netOrder.push(entry);
        if (session.netOrder.length > MAX_NET) {
          const dropped = session.netOrder.splice(0, session.netOrder.length - MAX_NET);
          for (const item of dropped) session.netByReqId.delete(item.id);
        }
      }
      break;
    }
    case 'Network.responseReceived': {
      const entry = session.netByReqId.get(String(params?.requestId ?? ''));
      if (entry) {
        entry.status = params.response?.status;
        entry.mime = params.response?.mimeType;
      }
      break;
    }
    case 'Network.loadingFinished': {
      const entry = session.netByReqId.get(String(params?.requestId ?? ''));
      if (entry) {
        entry.state = 'done';
        entry.size = Math.round(params?.encodedDataLength ?? 0);
      }
      break;
    }
    case 'Network.loadingFailed': {
      const entry = session.netByReqId.get(String(params?.requestId ?? ''));
      if (entry) {
        entry.state = 'failed';
        entry.error = params?.errorText || 'failed';
        if (!params?.canceled) {
          session.pushConsole('network', `FAILED ${entry.method} ${entry.url} — ${entry.error}`);
        }
      }
      break;
    }
  }
}

function safeJson(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

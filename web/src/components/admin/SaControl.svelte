<script>
  // 服务控制：运行状态 / 重启 / 更新 / 最近日志（SaService）+ 主机信息。
  // 重启靠守护进程（systemd / Docker / pm2）：本进程排空后退出，交给它拉起。
  import { sa } from '../../lib/serverAdmin.svelte.js';
  import SaService from './SaService.svelte';
  import { t } from '../../lib/i18n.js';
</script>

<SaService />

<div class="sa-card" style="margin-top:12px">
  <div class="sa-card-h">{t('主机')}</div>
  <div class="sa-rows">
    <div class="sa-row">
      <span class="sa-row-tx">{t('主机名')}</span>
      <span class="sa-mono sa-mut">{sa.overview?.host?.name || '—'}</span>
    </div>
    <div class="sa-row">
      <span class="sa-row-tx">{t('访问地址')}</span>
      <span class="sa-mono sa-mut sa-trunc" style="max-width:60%">{location.origin}</span>
    </div>
  </div>
  <div style="height:10px"></div>
</div>

<script>
  // 提问表单卡：渲染 ACP elicitation/create 请求（单选 single、多选 multi、文本、数字、布尔开关）。
  import { untrack } from 'svelte';
  import { submitAgyQuestion } from '../../lib/agy/store.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  const { question } = $props();

  let submitting = $state(false);
  let formValues = $state({});

  const keyOf = (f) => String(f?.key || f?.name || '');
  const isMulti = (f) => f?.kind === 'multi' || f?.kind === 'multiselect';
  const isSingle = (f) => f?.kind === 'single' || f?.kind === 'select';

  // 初始化表单默认值：untrack 读写 formValues，避免用户输入触发 $effect 自循环
  $effect(() => {
    const fields = Array.isArray(question.fields) ? question.fields : [];
    untrack(() => {
      for (const f of fields) {
        const fk = keyOf(f);
        if (!fk || formValues[fk] !== undefined) continue;
        if (f.defaultValue !== undefined) {
          formValues[fk] = Array.isArray(f.defaultValue) ? [...f.defaultValue] : f.defaultValue;
        } else if (isMulti(f)) {
          formValues[fk] = [];
        } else if (f.kind === 'boolean') {
          formValues[fk] = false;
        } else {
          formValues[fk] = '';
        }
      }
    });
  });

  const canSubmit = $derived.by(() => {
    const fields = Array.isArray(question.fields) ? question.fields : [];
    for (const f of fields) {
      if (!f?.required) continue;
      const val = formValues[keyOf(f)];
      if (isMulti(f) && (!Array.isArray(val) || val.length === 0)) return false;
      if (f.kind === 'number' && (val === '' || val === null || Number.isNaN(Number(val)))) return false;
      if ((f.kind === 'text' || isSingle(f)) && !String(val ?? '').trim()) return false;
    }
    return true;
  });

  function toggleMulti(fk, optVal) {
    const cur = Array.isArray(formValues[fk]) ? formValues[fk] : [];
    if (cur.includes(optVal)) {
      formValues[fk] = cur.filter((v) => v !== optVal);
    } else {
      formValues[fk] = [...cur, optVal];
    }
  }

  async function onSubmit(action) {
    if (submitting || question.status !== 'pending') return;
    submitting = true;
    try {
      if (action !== 'accept') {
        await submitAgyQuestion(question, action, {});
        return;
      }
      const payload = {};
      for (const f of (question.fields || [])) {
        const fk = keyOf(f);
        if (!fk) continue;
        const v = formValues[fk];
        if (f.kind === 'number') {
          if (v !== '' && v !== null && !Number.isNaN(Number(v))) payload[fk] = Number(v);
        } else if (f.kind === 'boolean') {
          payload[fk] = Boolean(v);
        } else {
          payload[fk] = v;
        }
      }
      await submitAgyQuestion(question, 'accept', payload);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="agy-qcard" class:pending={question.status === 'pending'}>
  <div class="agy-qhead">
    <span class="msr4 agy-qico">help</span>
    <span class="agy-qmsg sel-text">{tr(question.message) || t('需要补充信息')}</span>
    {#if question.status === 'answered'}
      <span class="agy-qbadge">{t('已提交')}</span>
    {:else if question.status === 'cancelled'}
      <span class="agy-qbadge">{t('已跳过')}</span>
    {/if}
  </div>

  {#if question.status === 'pending'}
    <div class="agy-qfields">
      {#each (question.fields || []) as field (keyOf(field))}
        {@const fk = keyOf(field)}
        <div class="agy-qfield">
          <div class="agy-qlabel">
            <span>{tr(field.title || fk)}</span>
            {#if field.required}<span class="req">*</span>{/if}
          </div>
          {#if field.description}
            <div class="agy-qdesc sel-text">{tr(field.description)}</div>
          {/if}

          {#if isSingle(field)}
            <div class="agy-qopts">
              {#each (field.options || []) as opt (opt.value)}
                <button
                  type="button"
                  class="agy-qpill"
                  class:sel={formValues[fk] === opt.value}
                  onclick={() => { formValues[fk] = opt.value; }}
                >
                  <span class="msr">{formValues[fk] === opt.value ? 'check_circle' : 'circle'}</span>
                  <span>{tr(opt.label ?? opt.value)}</span>
                </button>
              {/each}
            </div>
          {:else if isMulti(field)}
            <div class="agy-qopts">
              {#each (field.options || []) as opt (opt.value)}
                {@const picked = Array.isArray(formValues[fk]) && formValues[fk].includes(opt.value)}
                <button
                  type="button"
                  class="agy-qpill"
                  class:sel={picked}
                  onclick={() => toggleMulti(fk, opt.value)}
                >
                  <span class="msr">{picked ? 'check_circle' : 'circle'}</span>
                  <span>{tr(opt.label ?? opt.value)}</span>
                </button>
              {/each}
            </div>
          {:else if field.kind === 'boolean'}
            <button
              type="button"
              class="agy-qbool"
              class:on={Boolean(formValues[fk])}
              onclick={() => { formValues[fk] = !formValues[fk]; }}
            >
              <span class="msr">{formValues[fk] ? 'check_circle' : 'circle'}</span>
              <span>{formValues[fk] ? t('是') : t('否')}</span>
            </button>
          {:else if field.kind === 'number'}
            <input
              type="number"
              class="agy-qinput"
              value={formValues[fk] ?? ''}
              oninput={(e) => { formValues[fk] = e.currentTarget.value; }}
              placeholder={t('请输入数字')}
            />
          {:else}
            <input
              type="text"
              class="agy-qinput"
              value={formValues[fk] ?? ''}
              oninput={(e) => { formValues[fk] = e.currentTarget.value; }}
              placeholder={t('请输入内容')}
            />
          {/if}
        </div>
      {/each}
    </div>

    <div class="agy-qactions">
      <button
        type="button"
        class="agy-qbtn primary"
        disabled={submitting || !canSubmit}
        onclick={() => onSubmit('accept')}
      >
        {t('提交回答')}
      </button>
      <button
        type="button"
        class="agy-qbtn"
        disabled={submitting}
        onclick={() => onSubmit('cancel')}
      >
        {t('取消')}
      </button>
    </div>
  {:else if question.answer && Object.keys(question.answer).length > 0}
    <div class="agy-qsummary sel-text">
      {#each Object.entries(question.answer) as [k, v] (k)}
        <div class="agy-qans">
          <span class="k">{k}:</span>
          <span class="v">{Array.isArray(v) ? v.join(', ') : String(v)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .agy-qcard {
    margin: 8px 0;
    padding: 12px 14px;
    border-radius: 13px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-2);
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: agy-qcard-enter var(--ag-dur-quick, 200ms) var(--ag-ease-decel, cubic-bezier(0.05, 0.7, 0.1, 1)) both;
  }
  @keyframes agy-qcard-enter {
    from { opacity: 0; transform: translateY(6px); }
  }
  .agy-qcard.pending {
    border-color: var(--ag-accent-bd);
  }
  .agy-qhead {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13.5px;
  }
  .agy-qico {
    font-size: 18px;
    color: var(--ag-accent);
    margin-top: 1px;
  }
  .agy-qmsg {
    flex: 1;
    font-weight: 540;
    color: var(--ag-on);
    line-height: 1.45;
  }
  .agy-qbadge {
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--ag-surface-1);
    color: var(--ag-on-dim);
    flex: none;
  }
  .agy-qfields {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .agy-qfield {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .agy-qlabel {
    font-size: 12.5px;
    font-weight: 540;
    color: var(--ag-on-sub);
  }
  .agy-qlabel .req {
    color: var(--ag-err);
    margin-left: 3px;
  }
  .agy-qdesc {
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .agy-qopts {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .agy-qpill,
  .agy-qbool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    font-size: 12.5px;
    color: var(--ag-on-sub);
    width: fit-content;
  }
  .agy-qpill.sel,
  .agy-qbool.on {
    border-color: var(--ag-accent-bd);
    background: var(--ag-accent-soft);
    color: var(--ag-on);
  }
  .agy-qpill .msr,
  .agy-qbool .msr {
    font-size: 16px;
    color: var(--ag-accent);
  }
  .agy-qinput {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    border-radius: 9px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-cbox-bg);
    color: var(--ag-on);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  .agy-qinput:focus {
    border-color: var(--ag-accent);
  }
  .agy-qactions {
    display: flex;
    gap: 8px;
    padding-top: 2px;
  }
  .agy-qbtn {
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 540;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    color: var(--ag-on-sub);
  }
  .agy-qbtn.primary {
    background: var(--ag-accent-fill);
    border-color: transparent;
    color: var(--ag-on-accent);
  }
  .agy-qbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .agy-qsummary {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 10px;
    border-radius: 8px;
    background: var(--ag-surface-1);
    font-size: 12px;
    color: var(--ag-on-sub);
  }
  .agy-qans .k {
    color: var(--ag-on-dim);
    margin-right: 6px;
  }
</style>

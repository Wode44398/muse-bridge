<script>
  // 积木分派：按 block.type 挑组件，props 统一 { block, ctx }。section 在自己里面再用 Block 画孩子（递归）。
  // 树已经过服务端 normalizeBlocks 收口（字段截断、动作校验、不认识的 type 已丢）；这里不认识的 type 仍然什么都不画
  // （新服务端 + 旧前端时，新积木不会半截画出来）。
  import TextBlock from './TextBlock.svelte';
  import MarkdownBlock from './MarkdownBlock.svelte';
  import SectionBlock from './SectionBlock.svelte';
  import StatBlock from './StatBlock.svelte';
  import ListBlock from './ListBlock.svelte';
  import TableBlock from './TableBlock.svelte';
  import ButtonBlock from './ButtonBlock.svelte';
  import ButtonsBlock from './ButtonsBlock.svelte';
  import TabsBlock from './TabsBlock.svelte';
  import EmptyBlock from './EmptyBlock.svelte';
  import ImageBlock from './ImageBlock.svelte';
  import DividerBlock from './DividerBlock.svelte';
  import FormBlock from './FormBlock.svelte';
  import ChartBlock from './ChartBlock.svelte';
  import ChatBlock from './ChatBlock.svelte';

  let { block, ctx } = $props();

  const KINDS = {
    text: TextBlock, markdown: MarkdownBlock, section: SectionBlock, stat: StatBlock, list: ListBlock, table: TableBlock,
    button: ButtonBlock, buttons: ButtonsBlock, tabs: TabsBlock, empty: EmptyBlock, image: ImageBlock, divider: DividerBlock,
    form: FormBlock, chart: ChartBlock, chat: ChatBlock,
  };
  const Kind = $derived(block && typeof block.type === 'string' && Object.hasOwn(KINDS, block.type) ? KINDS[block.type] : null);
</script>

{#if Kind}<Kind {block} {ctx} />{/if}

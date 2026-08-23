import { Annotation } from "@langchain/langgraph";

const overwrite = (_prev, next) => next;

export const TradeState = Annotation.Root({
  symbol: Annotation({ reducer: overwrite, default: () => "" }),
  ohlc: Annotation({ reducer: overwrite, default: () => ({}) }),
  structure: Annotation({ reducer: overwrite, default: () => ({}) }),
  orderflow: Annotation({ reducer: overwrite, default: () => ({}) }),
  consensus: Annotation({ reducer: overwrite, default: () => ({}) }),
  levels: Annotation({ reducer: overwrite, default: () => ({}) }),
  geminiVerdict: Annotation({ reducer: overwrite, default: () => ({}) }),
  risk: Annotation({ reducer: overwrite, default: () => ({}) }),
  route: Annotation({ reducer: overwrite, default: () => "" }),
  decision: Annotation({ reducer: overwrite, default: () => ({}) }),
});

import { StateGraph, START, END } from "@langchain/langgraph";
import { TradeState } from "./state.js";
import {
  fetchDataNode,
  structureAgentNode,
  orderflowAgentNode,
  consensusNode,
  levelsNode,
  mechanicalGateNode,
  mechanicalRouteDecision,
  geminiVerdictNode,
  finalGateNode,
  routeDecision,
  tradeNode,
  waitNode,
} from "./nodes.js";

/**
 *                     START
 *                       |
 *                 fetch_data_node                     <- live bars from the charts service
 *                    /        \
 *      structure_agent_node   orderflow_agent_node     <- parallel, independent reads
 *                    \        /
 *                 consensus_node                       <- weighted MTF math (1W .4 / 1D .3 / 4H .2 / 1H .1)
 *                       |
 *                  levels_node                         <- OB / FVG / liquidity / OTE / equilibrium
 *                       |
 *               mechanical_gate_node                   <- composite edge + disagreement + zone check (no LLM call)
 *                    /        \
 *                  wait_node   gemini_verdict_node      <- LLM only spent on setups that already clear the bar
 *                        |            |
 *                        |       final_gate_node        <- Gemini can veto a "trade" call, never originate one
 *                        |         /       \
 *                        |    trade_node   wait_node
 *                         \       |        /
 *                              END
 */
export function buildGraph() {
  const g = new StateGraph(TradeState)
    .addNode("fetch_data", fetchDataNode)
    .addNode("structure_agent", structureAgentNode)
    .addNode("orderflow_agent", orderflowAgentNode)
    .addNode("consensus_node", consensusNode)
    .addNode("levels_node", levelsNode)
    .addNode("mechanical_gate", mechanicalGateNode)
    .addNode("gemini_verdict", geminiVerdictNode)
    .addNode("final_gate", finalGateNode)
    .addNode("trade_node", tradeNode)
    .addNode("wait_node", waitNode)
    .addEdge(START, "fetch_data")
    .addEdge("fetch_data", "structure_agent")
    .addEdge("fetch_data", "orderflow_agent") // fan-out: parallel agents
    .addEdge("structure_agent", "consensus_node")
    .addEdge("orderflow_agent", "consensus_node") // fan-in
    .addEdge("consensus_node", "levels_node")
    .addEdge("levels_node", "mechanical_gate")
    .addConditionalEdges("mechanical_gate", mechanicalRouteDecision, { trade: "gemini_verdict", wait: "wait_node" })
    .addEdge("gemini_verdict", "final_gate")
    .addConditionalEdges("final_gate", routeDecision, { trade: "trade_node", wait: "wait_node" })
    .addEdge("trade_node", END)
    .addEdge("wait_node", END);

  return g.compile();
}

import React, { useState, useEffect, useCallback, useRef } from "react"
import {
  Container, Row, Col, Card, CardBody, Button, Spinner, Alert, Input, Progress,
} from "reactstrap"
import {
  getWorkflow, getWatchlist, prepareRun, executeAgent, chartUrl,
  createCancelSource, isCancel,
} from "../../helpers/connector_helper"

/**
 * Group nodes into levels that can run in parallel: everything whose parents
 * have already run goes in the same level. Mirrors the connector's own
 * workflowEngine so the canvas and the scheduler execute the graph identically.
 */
function topologicalLevels(nodeIds, edges) {
  const indegree = new Map(nodeIds.map(id => [id, 0]))
  const children = new Map(nodeIds.map(id => [id, []]))

  edges.forEach(e => {
    if (!indegree.has(e.target) || !children.has(e.source)) return
    indegree.set(e.target, indegree.get(e.target) + 1)
    children.get(e.source).push(e.target)
  })

  const levels = []
  let frontier = nodeIds.filter(id => indegree.get(id) === 0)
  const seen = new Set()

  while (frontier.length) {
    levels.push(frontier)
    frontier.forEach(id => seen.add(id))
    const next = []
    frontier.forEach(id => {
      children.get(id).forEach(child => {
        indegree.set(child, indegree.get(child) - 1)
        if (indegree.get(child) === 0 && !seen.has(child)) next.push(child)
      })
    })
    frontier = [...new Set(next)]
  }

  // A cycle would strand nodes; run them last rather than dropping them.
  const stranded = nodeIds.filter(id => !seen.has(id))
  if (stranded.length) levels.push(stranded)
  return levels
}

/** The decision agent answers in JSON, sometimes inside a code fence. */
function parseVerdict(raw) {
  if (!raw) return null
  const cleaned = String(raw).replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    return null
  }
}

const STATUS_COLOR = { idle: "secondary", running: "info", done: "success", error: "danger" }
const VERDICT_COLOR = { BUY: "success", SELL: "danger", HOLD: "warning" }

/**
 * reactstrap 8 still emits Bootstrap 4's `badge-*` classes, which Bootstrap 5
 * replaced with `bg-*` — its <Badge> renders white-on-white here. Plain spans
 * with the v5 classes are the reliable option.
 */
const Pill = ({ color, children, className = "" }) => (
  <span
    className={`badge bg-${color} ${color === "warning" ? "text-dark" : ""} ${className}`}
  >
    {children}
  </span>
)

const Workflows = () => {
  const [agents, setAgents] = useState([])
  const [edges, setEdges] = useState([])
  const [symbols, setSymbols] = useState([])
  const [symbol, setSymbol] = useState("")
  const [prepared, setPrepared] = useState(null)
  const [state, setState] = useState({})       // agentId -> {status, output, latency, tokenCount, error}
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState({})
  const abortRef = useRef(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [wf, wl] = await Promise.all([getWorkflow(), getWatchlist()])
        setAgents(wf.agents || [])
        setEdges(wf.edges || [])
        setSymbols(wl.symbols || [])
        if (wl.symbols?.length) setSymbol(wl.symbols[0].symbol)
      } catch (err) {
        setError(err.response?.data?.error || err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Cancel any in-flight run if the page unmounts mid-execution.
  useEffect(() => () => abortRef.current?.cancel("unmounted"), [])

  const handleLoad = useCallback(async () => {
    setPreparing(true)
    setError(null)
    setPrepared(null)
    setState({})
    try {
      const run = await prepareRun(symbol)
      setPrepared(run)
      setAgents(run.agents)
      setEdges(run.edges || [])
      setState(Object.fromEntries(run.agents.map(a => [a.id, { status: "idle" }])))
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setPreparing(false)
    }
  }, [symbol])

  const handleRun = useCallback(async () => {
    if (!prepared) return
    const source = createCancelSource()
    abortRef.current = source

    setRunning(true)
    setError(null)
    setState(Object.fromEntries(prepared.agents.map(a => [a.id, { status: "idle" }])))

    const byId = new Map(prepared.agents.map(a => [a.id, a]))
    const levels = topologicalLevels(prepared.agents.map(a => a.id), prepared.edges || [])
    const outputs = {}

    let cancelled = false
    try {
      for (const level of levels) {
        if (cancelled) break

        await Promise.all(level.map(async id => {
          const agent = byId.get(id)
          if (!agent) return

          // Feed this node its parents' outputs; roots get the run's brief.
          const parents = (prepared.edges || [])
            .filter(e => e.target === id)
            .map(e => outputs[e.source])
            .filter(Boolean)
          const input = parents.length ? parents.join("\n\n---\n\n") : prepared.userInput

          setState(s => ({ ...s, [id]: { status: "running" } }))
          try {
            const data = await executeAgent(agent, input, source.token)
            const output = data.output || ""
            if (!output.trim()) throw new Error("Model returned an empty response")
            outputs[id] = output
            setState(s => ({
              ...s,
              [id]: {
                status: "done",
                output,
                latency: data.latency,
                tokenCount: data.tokenCount,
                model: data.model,
              },
            }))
          } catch (err) {
            if (isCancel(err)) {
              cancelled = true
              setState(s => ({ ...s, [id]: { status: "idle" } }))
              return
            }
            setState(s => ({
              ...s,
              [id]: { status: "error", error: err.response?.data?.error || err.message },
            }))
          }
        }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [prepared])

  const handleStop = useCallback(() => {
    abortRef.current?.cancel("stopped by user")
    setRunning(false)
  }, [])

  if (loading) return <div className="page-content"><Container fluid><Spinner /></Container></div>

  const done = Object.values(state).filter(s => s.status === "done").length
  const total = agents.length
  const verdict = parseVerdict(state.decision?.output)
  const totalTokens = Object.values(state).reduce((n, s) => n + (s.tokenCount || 0), 0)

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="12">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <div>
                  <h4 className="mb-0">Workflow Run</h4>
                  <small className="text-muted">
                    {total} agents, {edges.length} edges
                    {prepared && ` · ${prepared.label}`}
                    {totalTokens > 0 && ` · ${totalTokens.toLocaleString()} tokens`}
                  </small>
                </div>
                <div className="d-flex align-items-center gap-2">
                  <Input
                    type="select"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value)}
                    disabled={preparing || running}
                    style={{ width: "auto" }}
                  >
                    {symbols.map(s => (
                      <option key={s.symbol} value={s.symbol}>{s.label || s.symbol}</option>
                    ))}
                  </Input>
                  <Button color="secondary" outline onClick={handleLoad} disabled={preparing || running || !symbol}>
                    {preparing ? <><Spinner size="sm" className="me-1" /> Loading…</> : "Load Data"}
                  </Button>
                  {running ? (
                    <Button color="danger" onClick={handleStop}>Stop</Button>
                  ) : (
                    <Button color="primary" onClick={handleRun} disabled={!prepared}>
                      <i className="mdi mdi-play me-1" />Run Workflow
                    </Button>
                  )}
                </div>
              </div>
            </Col>
          </Row>

          {error && <Alert color="danger">{error}</Alert>}
          {!prepared && !error && (
            <Alert color="info">
              Pick a symbol and choose <strong>Load Data</strong> to fetch charts and ICT facts,
              then <strong>Run Workflow</strong>.
            </Alert>
          )}

          {running && (
            <Progress className="mb-3" value={total ? (done / total) * 100 : 0} striped animated>
              {done}/{total}
            </Progress>
          )}

          {verdict && (
            <Row className="mb-4">
              <Col lg="12">
                <Card className="border border-2">
                  <CardBody>
                    <div className="d-flex align-items-center mb-3">
                      <h5 className="card-title mb-0 me-3">Trade Decision</h5>
                      <Pill color={VERDICT_COLOR[verdict.verdict] || "secondary"} className="fs-6 me-2">
                        {verdict.verdict}
                      </Pill>
                      <span className="text-muted">
                        confidence {Math.round((verdict.confidence || 0) * 100)}% · {verdict.timeframe || "—"}
                      </span>
                    </div>
                    <Row>
                      {[
                        ["Entry", verdict.entry], ["Stop", verdict.stop],
                        ["Targets", (verdict.targets || []).join(", ")], ["R:R", verdict.riskReward],
                      ].map(([label, value]) => (
                        <Col md="3" key={label}>
                          <small className="text-muted d-block">{label}</small>
                          <span className="fw-medium">{value || value === 0 ? value : "—"}</span>
                        </Col>
                      ))}
                    </Row>
                    {verdict.rationale && <p className="mt-3 mb-1">{verdict.rationale}</p>}
                    {verdict.invalidation && (
                      <p className="text-muted mb-0"><small><strong>Invalidation:</strong> {verdict.invalidation}</small></p>
                    )}
                  </CardBody>
                </Card>
              </Col>
            </Row>
          )}

          <Row className="mb-4">
            <Col lg="12">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Agents ({total})</h5>
                  <div className="table-responsive">
                    <table className="table table-hover align-middle mb-0">
                      <thead className="table-light">
                        <tr>
                          <th>Agent</th><th>Status</th><th>Vision</th>
                          <th>Latency</th><th>Tokens</th><th>Output</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map(agent => {
                          const s = state[agent.id] || { status: "idle" }
                          const images = (agent.images || []).length
                          return (
                            <React.Fragment key={agent.id}>
                              <tr>
                                <td className="fw-medium">{agent.label || agent.name || agent.id}</td>
                                <td>
                                  <Pill color={STATUS_COLOR[s.status]}>
                                    {s.status === "running" && <Spinner size="sm" className="me-1" />}
                                    {s.status}
                                  </Pill>
                                </td>
                                <td>
                                  {images > 0
                                    ? <Pill color="dark"><i className="mdi mdi-eye me-1" />{images}</Pill>
                                    : <span className="text-muted">—</span>}
                                </td>
                                <td>{s.latency ? `${(s.latency / 1000).toFixed(1)}s` : "—"}</td>
                                <td>{s.tokenCount ? s.tokenCount.toLocaleString() : "—"}</td>
                                <td>
                                  {s.output ? (
                                    <Button size="sm" color="link" className="p-0"
                                      onClick={() => setExpanded(e => ({ ...e, [agent.id]: !e[agent.id] }))}>
                                      {expanded[agent.id] ? "Hide" : "View"}
                                    </Button>
                                  ) : s.error ? (
                                    <small className="text-danger">{s.error}</small>
                                  ) : <span className="text-muted">—</span>}
                                </td>
                              </tr>
                              {expanded[agent.id] && s.output && (
                                <tr>
                                  <td colSpan="6" className="bg-light">
                                    <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "400px", overflow: "auto" }}>
                                      {s.output}
                                    </pre>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </Col>
          </Row>

          {prepared?.charts && Object.keys(prepared.charts).length > 0 && (
            <Row>
              <Col lg="12">
                <Card>
                  <CardBody>
                    <h5 className="card-title mb-3">Annotated Charts</h5>
                    <Row>
                      {Object.entries(prepared.charts).map(([key, path]) => (
                        <Col md="6" key={key} className="mb-3">
                          <small className="text-muted d-block mb-1">
                            {key} · {prepared.timeframes?.[key]}
                          </small>
                          <img src={chartUrl(path)} alt={key} className="img-fluid rounded border" />
                        </Col>
                      ))}
                    </Row>
                  </CardBody>
                </Card>
              </Col>
            </Row>
          )}
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Workflows

import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Collapse, Input, FormGroup, Spinner, Alert, Button } from "reactstrap"
import { getSignals, chartUrl } from "../../helpers/connector_helper"
import ChartLightbox from "../../components/Common/ChartLightbox"

const STATUS_ICON = {
  ok: { icon: "mdi-check-circle", color: "text-success" },
  error: { icon: "mdi-alert-circle", color: "text-danger" },
}

const getVerdictBadge = (verdict) => {
  if (!verdict) return <Badge color="secondary">—</Badge>
  switch (verdict) {
    case "BUY": return <Badge color="success">BUY</Badge>
    case "SELL": return <Badge color="danger">SELL</Badge>
    case "HOLD": return <Badge color="info">HOLD</Badge>
    default: return <Badge color="secondary">{verdict}</Badge>
  }
}

// Preferred left-to-right order for chart thumbnails — HTF to execution
// timeframe. Anything not in this list (e.g. the old single-chart "15" key
// from pre-MTF workflows) just sorts after it.
const CHART_ORDER = ["1W", "1D", "4H", "1H", "15M", "15"]
const sortChartKeys = (keys) => [...keys].sort((a, b) => {
  const ia = CHART_ORDER.indexOf(a), ib = CHART_ORDER.indexOf(b)
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
})

/** HTF per-timeframe scores from one independent agent (the Visual/Quantitative Analyst roles). */
const AssessmentsTable = ({ assessments }) => (
  <div className="table-responsive mb-2">
    <table className="table table-sm table-bordered mb-0">
      <thead className="table-light">
        <tr><th>TF</th><th>Bias</th><th>Score</th><th>Confidence</th><th>Notes</th></tr>
      </thead>
      <tbody>
        {assessments.map((a) => (
          <tr key={a.timeframe}>
            <td className="fw-medium">{a.timeframe}</td>
            <td>{a.bias}</td>
            <td>{a.bias_score}</td>
            <td>{a.confidence}</td>
            <td className="small text-muted">{a.market_structure}{a.poi ? ` · ${a.poi}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

/** Deterministic consensus math step — both agents' scores side by side, plus the unified/disagreement values. */
const ConsensusTable = ({ perTimeframe }) => (
  <div className="table-responsive mb-2">
    <table className="table table-sm table-bordered mb-0">
      <thead className="table-light">
        <tr><th>TF</th><th>Weight</th><th>Agent 1</th><th>Agent 2</th><th>Unified S</th><th>Disagreement D</th></tr>
      </thead>
      <tbody>
        {perTimeframe.map((tf) => (
          <tr key={tf.timeframe}>
            <td className="fw-medium">{tf.timeframe}</td>
            <td>{tf.weight}</td>
            <td>{tf.agent1 ? `${tf.agent1.bias} (${tf.agent1.bias_score})` : "—"}</td>
            <td>{tf.agent2 ? `${tf.agent2.bias} (${tf.agent2.bias_score})` : "—"}</td>
            <td>{typeof tf.S === "number" ? tf.S.toFixed(2) : tf.S}</td>
            <td>{typeof tf.D === "number" ? tf.D.toFixed(2) : tf.D}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const PAGE_SIZE = 25

const Logs = () => {
  const [runs, setRuns] = useState([])
  const [filter, setFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openIds, setOpenIds] = useState(new Set())
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        const data = await getSignals({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        if (cancelled) return
        setRuns(data.signals || [])
        setHasMore(Boolean(data.hasMore))
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [page])

  // Filtering runs within a page rather than resetting to page 0 keeps the
  // control simple; a mismatch just means a filtered page can look sparse.

  const toggle = (id) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredRuns = filter === "all"
    ? runs
    : filter === "error"
      ? runs.filter((r) => r.error)
      : runs.filter((r) => r.verdict === filter)

  if (loading) return <Spinner />
  if (error) return <Alert color="danger">{error}</Alert>

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="6">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <h4 className="mb-sm-0">Logs</h4>
              </div>
            </Col>
            <Col sm="6" className="text-sm-end">
              <FormGroup className="d-inline-block me-2" style={{ width: "180px" }}>
                <Input type="select" value={filter} onChange={(e) => setFilter(e.target.value)} size="sm">
                  <option value="all">All Runs</option>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                  <option value="HOLD">HOLD</option>
                  <option value="error">Errors</option>
                </Input>
              </FormGroup>
            </Col>
          </Row>

          {filteredRuns.map((run) => {
            const isOpen = openIds.has(run.id)
            return (
              <Card key={run.id} className="mb-2">
                <div
                  className="card-body d-flex justify-content-between align-items-center"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggle(run.id)}
                >
                  <div className="d-flex align-items-center gap-3">
                    <i className={`mdi ${isOpen ? "mdi-chevron-down" : "mdi-chevron-right"}`}></i>
                    <small className="text-muted">{new Date(run.at).toLocaleString()}</small>
                    <span className="fw-medium">{run.workflowName || run.label || run.symbol}</span>
                    <Badge color="light" className="text-dark">{run.symbol}</Badge>
                    {getVerdictBadge(run.verdict)}
                    {run.error && <Badge color="danger">error</Badge>}
                  </div>
                  <small className="text-muted">{run.agents?.length || 0} step(s)</small>
                </div>
                <Collapse isOpen={isOpen}>
                  <CardBody className="border-top pt-3">
                    {run.error && <Alert color="danger">{run.error}</Alert>}
                    {run.rationale && <p className="mb-3">{run.rationale}</p>}
                    {run.charts && Object.keys(run.charts).length > 0 && (
                      <div className="mb-3">
                        <small className="text-muted d-block mb-1">Charts passed to vision agents:</small>
                        <div className="d-flex gap-2 flex-wrap">
                          {sortChartKeys(Object.keys(run.charts)).map((label) => run.charts[label] && (
                            <div key={label} className="text-center">
                              <img
                                src={chartUrl(run.charts[label])}
                                alt={label}
                                style={{ width: "110px", height: "auto", borderRadius: "4px", cursor: "pointer", border: "1px solid #dee2e6" }}
                                onClick={() => setLightboxUrl(chartUrl(run.charts[label]))}
                              />
                              <div className="small text-muted">{label}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {(run.agents || []).map((agent) => {
                      const style = STATUS_ICON[agent.status] || { icon: "mdi-circle-outline", color: "text-muted" }
                      return (
                        <div key={agent.id} className="mb-3 pb-3 border-bottom">
                          <div className="fw-medium mb-2">
                            <i className={`mdi ${style.icon} ${style.color} me-1`}></i>
                            {agent.label}
                            {agent.latencyMs != null && <small className="text-muted ms-2">{agent.latencyMs}ms</small>}
                          </div>
                          {agent.error && <Alert color="danger" className="py-1 px-2 small">{agent.error}</Alert>}
                          {agent.structured?.assessments && <AssessmentsTable assessments={agent.structured.assessments} />}
                          {agent.structured?.perTimeframe && <ConsensusTable perTimeframe={agent.structured.perTimeframe} />}
                          {agent.input && (
                            <div className="mb-2">
                              <small className="text-muted d-block mb-1">Input / data given to this step:</small>
                              <pre className="small bg-light p-2 rounded" style={{ whiteSpace: "pre-wrap", maxHeight: "200px", overflow: "auto" }}>
                                {agent.input}
                              </pre>
                            </div>
                          )}
                          {agent.output && (
                            <div>
                              <small className="text-muted d-block mb-1">Reasoning / output:</small>
                              <pre className="small bg-light p-2 rounded" style={{ whiteSpace: "pre-wrap", maxHeight: "300px", overflow: "auto" }}>
                                {agent.output}
                              </pre>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {!run.agents?.length && <p className="text-muted small mb-0">No per-step trace recorded for this run.</p>}
                  </CardBody>
                </Collapse>
              </Card>
            )
          })}

          {!filteredRuns.length && (
            <Card><CardBody className="text-center text-muted py-5">No runs yet. Trigger a workflow to generate logs.</CardBody></Card>
          )}

          <div className="d-flex justify-content-between align-items-center mt-3">
            <Button
              color="light"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(p - 1, 0))}
            >
              <i className="mdi mdi-chevron-left me-1"></i>Prev
            </Button>
            <small className="text-muted">Page {page + 1}</small>
            <Button
              color="light"
              size="sm"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next<i className="mdi mdi-chevron-right ms-1"></i>
            </Button>
          </div>
        </Container>
      </div>

      <ChartLightbox url={lightboxUrl} isOpen={Boolean(lightboxUrl)} toggle={() => setLightboxUrl(null)} />
    </React.Fragment>
  )
}

export default Logs

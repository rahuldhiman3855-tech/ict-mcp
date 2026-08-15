import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert } from "reactstrap"
import { getWatchlist, getSignals, schedulerAction, getScheduler, runSymbol } from "../../helpers/connector_helper"

const Crons = () => {
  const [watchlist, setWatchlist] = useState([])
  const [scheduler, setScheduler] = useState(null)
  const [latestSignals, setLatestSignals] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [wl, sch, sigs] = await Promise.all([
          getWatchlist(),
          getScheduler(),
          getSignals({ latest: true }),
        ])
        setWatchlist(wl.symbols || [])
        setScheduler(sch)
        const sigMap = {}
        if (sigs.signals) {
          for (const sig of sigs.signals) {
            sigMap[sig.symbol] = sig
          }
        }
        setLatestSignals(sigMap)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  const handleSchedulerAction = async (action) => {
    try {
      const result = await schedulerAction(action)
      setScheduler(result)
    } catch (err) {
      setError(`Scheduler action failed: ${err.message}`)
    }
  }

  const handleRunNow = async (symbol) => {
    try {
      await runSymbol(symbol)
      // Refresh signals
      const sigs = await getSignals({ latest: true })
      const sigMap = {}
      if (sigs.signals) {
        for (const sig of sigs.signals) {
          sigMap[sig.symbol] = sig
        }
      }
      setLatestSignals(sigMap)
    } catch (err) {
      setError(`Run failed: ${err.message}`)
    }
  }

  if (loading) return <Spinner />
  if (error) return <Alert color="danger">{error}</Alert>

  const getVerdictBadge = (verdict) => {
    if (!verdict) return <Badge color="secondary">—</Badge>
    switch (verdict) {
      case "BUY":
        return <Badge color="success">BUY</Badge>
      case "SELL":
        return <Badge color="danger">SELL</Badge>
      case "HOLD":
        return <Badge color="info">HOLD</Badge>
      default:
        return <Badge color="secondary">{verdict}</Badge>
    }
  }

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="12">
              <div className="page-title-box d-sm-flex align-items-center justify-content-between">
                <div>
                  <h4 className="mb-0">Scheduler Status</h4>
                  {scheduler && (
                    <small className="text-muted">
                      {scheduler.enabled ? `Enabled — every ${scheduler.intervalMs / 60000} minutes` : "Disabled"}
                    </small>
                  )}
                </div>
                <div className="d-flex gap-2">
                  <Button size="sm" color="primary" onClick={() => handleSchedulerAction("start")}>
                    <i className="mdi mdi-play me-1"></i>Start
                  </Button>
                  <Button size="sm" color="warning" onClick={() => handleSchedulerAction("stop")}>
                    <i className="mdi mdi-stop me-1"></i>Stop
                  </Button>
                  <Button size="sm" color="info" onClick={() => handleSchedulerAction("trigger")}>
                    <i className="mdi mdi-lightning-bolt me-1"></i>Trigger Now
                  </Button>
                </div>
              </div>
            </Col>
          </Row>

          <Row>
            <Col lg="12">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Watchlist Symbols</h5>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0">
                      <thead className="table-light">
                        <tr>
                          <th>Symbol</th>
                          <th>Label</th>
                          <th>Class</th>
                          <th>Latest Verdict</th>
                          <th>Confidence</th>
                          <th>Last Run</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {watchlist.map((symbol) => {
                          const signal = latestSignals[symbol.symbol]
                          return (
                            <tr key={symbol.symbol}>
                              <td className="fw-medium">{symbol.symbol}</td>
                              <td>{symbol.label || "—"}</td>
                              <td><Badge bg="light" text="dark">{symbol.class || "—"}</Badge></td>
                              <td>{signal ? getVerdictBadge(signal.verdict) : "—"}</td>
                              <td>{signal?.confidence ? `${(signal.confidence * 100).toFixed(0)}%` : "—"}</td>
                              <td><small>{signal?.at ? new Date(signal.at).toLocaleString() : "—"}</small></td>
                              <td>
                                <Button size="sm" color="info" outline onClick={() => handleRunNow(symbol.symbol)}>
                                  <i className="mdi mdi-play"></i>
                                </Button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Crons

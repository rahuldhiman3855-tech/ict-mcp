import React, { useState, useEffect } from "react"
import {
  Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert,
  Modal, ModalHeader, ModalBody, ModalFooter, Form, FormGroup, Label, Input,
} from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import ChartLightbox from "../../components/Common/ChartLightbox"
import {
  listWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, runWorkflow,
  listAgents, checkSymbol, getSymbolSignals, chartUrl,
  startWorkflowSchedule, stopWorkflowSchedule,
} from "../../helpers/connector_helper"

const EMPTY_FORM = { name: "", symbol: "", agentIds: [], cronExpression: "", enabled: true }

const getVerdictBadge = (verdict) => {
  if (!verdict) return <Badge color="secondary">—</Badge>
  switch (verdict) {
    case "BUY": return <Badge color="success">BUY</Badge>
    case "SELL": return <Badge color="danger">SELL</Badge>
    case "HOLD": return <Badge color="info">HOLD</Badge>
    default: return <Badge color="secondary">{verdict}</Badge>
  }
}

const STATUS_ICON = {
  ok: { icon: "mdi-check-circle", color: "text-success" },
  error: { icon: "mdi-alert-circle", color: "text-danger" },
}

const Workflows = () => {
  const [workflows, setWorkflows] = useState([])
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState(null)

  const [running, setRunning] = useState(null) // workflow id currently running
  const [runResult, setRunResult] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [togglingId, setTogglingId] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const [wf, ag] = await Promise.all([listWorkflows(), listAgents()])
      setWorkflows(wf.workflows || [])
      setAgents(ag.agents || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openNew = () => { setForm(EMPTY_FORM); setCheckResult(null); setEditing({}) }
  const openEdit = (wf) => {
    setForm({
      name: wf.name,
      symbol: wf.symbol,
      agentIds: wf.agent_ids,
      cronExpression: wf.cron_expression || "",
      enabled: wf.enabled,
    })
    setCheckResult({ ok: true })
    setEditing(wf)
  }
  const close = () => setEditing(null)

  const handleChange = (e) => {
    const { name, type, checked, value } = e.target
    if (name === "symbol") setCheckResult(null)
    setForm({ ...form, [name]: type === "checkbox" ? checked : value })
  }

  const handleCheckSymbol = async () => {
    if (!form.symbol.trim()) return
    try {
      setChecking(true)
      const result = await checkSymbol(form.symbol.trim().toUpperCase())
      setCheckResult(result)
    } catch (err) {
      setCheckResult({ ok: false, error: err.message })
    } finally {
      setChecking(false)
    }
  }

  // A workflow's agentIds is stage-based: each entry is a single agent id
  // (a sequential step) or an array of ids (a parallel group, e.g. two
  // independent scorers reading the same data). Normalize to always-array
  // form for editing, so toggling/reordering never has to special-case it.
  const asStages = (agentIds) => (agentIds || []).map((s) => (Array.isArray(s) ? s : [s]))

  const toggleAgent = (id) => {
    setForm((f) => {
      const stages = asStages(f.agentIds)
      const flat = stages.flat()
      if (flat.includes(id)) {
        const next = stages.map((s) => s.filter((a) => a !== id)).filter((s) => s.length > 0)
        return { ...f, agentIds: next }
      }
      // New agents default to their own sequential stage — use the ∥ button
      // to merge one into the stage before it (run in parallel).
      return { ...f, agentIds: [...stages, [id]] }
    })
  }

  /** Merge this agent's stage into the stage before it (run in parallel), or split it back out into its own stage if it's already grouped. */
  const toggleParallel = (id) => {
    setForm((f) => {
      const stages = asStages(f.agentIds)
      const stageIdx = stages.findIndex((s) => s.includes(id))
      if (stageIdx === -1) return f
      if (stages[stageIdx].length > 1) {
        const withoutAgent = stages[stageIdx].filter((a) => a !== id)
        const next = [...stages]
        next.splice(stageIdx, 1, withoutAgent, [id])
        return { ...f, agentIds: next }
      }
      if (stageIdx === 0) return f // nothing before the first stage to merge with
      const next = [...stages]
      next[stageIdx - 1] = [...next[stageIdx - 1], id]
      next.splice(stageIdx, 1)
      return { ...f, agentIds: next }
    })
  }

  /** Moves this agent's whole stage — a parallel pair moves together. */
  const moveAgent = (id, dir) => {
    setForm((f) => {
      const stages = asStages(f.agentIds)
      const i = stages.findIndex((s) => s.includes(id))
      const j = i + dir
      if (i < 0 || j < 0 || j >= stages.length) return f
      ;[stages[i], stages[j]] = [stages[j], stages[i]]
      return { ...f, agentIds: stages }
    })
  }

  const mechanicalError = (() => {
    const stages = asStages(form.agentIds)
    const mechIdx = stages.findIndex((s) => s.includes(0))
    if (mechIdx === -1) return null
    const isLastAlone = mechIdx === stages.length - 1 && stages[mechIdx].length === 1
    return isLastAlone ? null : "The mechanical agent must be the last step in the workflow, and run alone (not in a parallel group)."
  })()

  const handleSave = async (e) => {
    e.preventDefault()
    if (!checkResult?.ok) {
      setError("Check the symbol before saving.")
      return
    }
    if (mechanicalError) {
      setError(mechanicalError)
      return
    }
    try {
      setSaving(true)
      setError(null)
      const payload = { ...form, symbol: form.symbol.trim().toUpperCase() }
      if (editing?.id) await updateWorkflow(editing.id, payload)
      else await createWorkflow(payload)
      close()
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  /** Disabling stops the workflow's live cron task (see cronScheduler.reconcileOne); enabling re-registers it. */
  const handleToggleEnabled = async (wf) => {
    try {
      setTogglingId(wf.id)
      setError(null)
      if (wf.enabled) await stopWorkflowSchedule(wf.id)
      else await startWorkflowSchedule(wf.id)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async (wf) => {
    try {
      await deleteWorkflow(wf.id)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleRun = async (wf) => {
    try {
      setRunning(wf.id)
      setRunResult(null)
      const before = Date.now()
      await runWorkflow(wf.id)

      // Poll for the new signal record — the run is fire-and-forget server-side.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const data = await getSymbolSignals(wf.symbol)
        const fresh = (data.signals || []).find((s) => new Date(s.at).getTime() >= before)
        if (fresh) { setRunResult(fresh); break }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(null)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="Workflows" />

          {error && <Alert color="danger">{error}</Alert>}

          <Row className="mb-3">
            <Col className="d-flex justify-content-end">
              <Button color="primary" onClick={openNew}>
                <i className="mdi mdi-plus me-1"></i>New Workflow
              </Button>
            </Col>
          </Row>

          <Row>
            {workflows.map((wf) => (
              <Col lg="6" key={wf.id} className="mb-3">
                <Card>
                  <CardBody>
                    <div className="d-flex justify-content-between align-items-start mb-2">
                      <div>
                        <h5 className="card-title mb-0">{wf.name}</h5>
                        <small className="text-muted">{wf.symbol}</small>
                      </div>
                      <Button
                        size="sm"
                        color={wf.enabled ? "success" : "secondary"}
                        outline={!wf.enabled}
                        onClick={() => handleToggleEnabled(wf)}
                        disabled={togglingId === wf.id}
                        title={wf.enabled ? "Disable — stops this workflow's cron runs" : "Enable — resumes this workflow's cron runs"}
                      >
                        {togglingId === wf.id
                          ? <Spinner size="sm" />
                          : <><i className={`mdi ${wf.enabled ? "mdi-toggle-switch" : "mdi-toggle-switch-off"} me-1`}></i>{wf.enabled ? "Enabled" : "Disabled"}</>}
                      </Button>
                    </div>
                    <div className="small mb-2">
                      Agents: {wf.agentNames?.join(" → ") || "—"}
                    </div>
                    {wf.cron_expression && (
                      <div className="small text-muted mb-2"><code>{wf.cron_expression}</code></div>
                    )}
                    <div className="d-flex gap-2 mb-2">
                      <Button size="sm" color="primary" onClick={() => handleRun(wf)} disabled={running === wf.id}>
                        {running === wf.id ? <><Spinner size="sm" className="me-1" />Running...</> : <><i className="mdi mdi-play me-1"></i>Run Now</>}
                      </Button>
                      <Button size="sm" color="secondary" outline onClick={() => openEdit(wf)}>
                        <i className="mdi mdi-pencil"></i>
                      </Button>
                      <Button size="sm" color="danger" outline onClick={() => handleDelete(wf)}>
                        <i className="mdi mdi-delete"></i>
                      </Button>
                    </div>

                    {running === null && runResult && runResult.workflowId === wf.id && (
                      <div className="border-top pt-2 mt-2">
                        <div className="d-flex align-items-center gap-2 mb-1">
                          {getVerdictBadge(runResult.verdict)}
                          {runResult.confidence != null && <small className="text-muted">confidence {Math.round(runResult.confidence)}%</small>}
                        </div>
                        {runResult.rationale && <p className="small mb-1">{runResult.rationale}</p>}
                        {runResult.agents?.map((a) => {
                          const style = STATUS_ICON[a.status] || { icon: "mdi-circle-outline", color: "text-muted" }
                          return (
                            <div key={a.id} className="small mb-1">
                              <i className={`mdi ${style.icon} ${style.color} me-1`}></i>{a.label}
                            </div>
                          )
                        })}
                        {runResult.charts?.["15"] && (
                          <Button size="sm" color="secondary" outline onClick={() => setLightboxUrl(chartUrl(runResult.charts["15"]))}>
                            <i className="mdi mdi-arrow-expand me-1"></i>View Chart
                          </Button>
                        )}
                      </div>
                    )}
                  </CardBody>
                </Card>
              </Col>
            ))}
            {!workflows.length && (
              <Col><p className="text-muted">No workflows yet. Create agents first, then chain them into a workflow.</p></Col>
            )}
          </Row>
        </Container>
      </div>

      <Modal isOpen={Boolean(editing)} toggle={close} size="lg">
        <ModalHeader toggle={close}>{editing?.id ? "Edit Workflow" : "New Workflow"}</ModalHeader>
        <Form onSubmit={handleSave}>
          <ModalBody>
            <FormGroup className="mb-3">
              <Label>Name</Label>
              <Input type="text" name="name" value={form.name} onChange={handleChange} required />
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>Symbol</Label>
              <div className="d-flex gap-2">
                <Input type="text" name="symbol" value={form.symbol} onChange={handleChange} placeholder="NSE:RELIANCE" required />
                <Button type="button" color="secondary" outline onClick={handleCheckSymbol} disabled={checking || !form.symbol.trim()}>
                  {checking ? <Spinner size="sm" /> : "Check"}
                </Button>
              </div>
              {checkResult && (
                <small className={checkResult.ok ? "text-success" : "text-danger"}>
                  <i className={`mdi ${checkResult.ok ? "mdi-check" : "mdi-close"} me-1`}></i>
                  {checkResult.ok ? "Symbol resolves." : checkResult.error}
                </small>
              )}
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>Agents (in order)</Label>
              <p className="small text-muted mb-2">
                Checked agents run in the numbered order shown. The <strong>∥</strong> button merges an agent into
                the step right before it, so both run in parallel (e.g. two independent scorers reading the same
                data) instead of one after the other.
              </p>
              {!agents.length && <p className="small text-muted">No agents yet — create one on the Agents page first.</p>}
              {mechanicalError && <Alert color="warning" className="py-1 px-2 small">{mechanicalError}</Alert>}
              {(() => {
                const stages = asStages(form.agentIds)
                const membership = new Map()
                stages.forEach((s, stageIdx) => s.forEach((id) => membership.set(id, { stageIdx, stageSize: s.length })))

                return agents.map((agent) => {
                  const info = membership.get(agent.id)
                  const selected = Boolean(info)
                  return (
                    <div key={agent.id} className="d-flex align-items-center gap-2 mb-1">
                      <input
                        type="checkbox"
                        className="form-check-input"
                        checked={selected}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <span className="flex-grow-1">
                        {selected && (
                          <Badge color="secondary" className="me-2">
                            {info.stageIdx + 1}{info.stageSize > 1 ? " ∥" : ""}
                          </Badge>
                        )}
                        {agent.name}
                        {agent.kind === "mechanical" && <Badge color="warning" className="ms-2">mechanical</Badge>}
                      </span>
                      {selected && (
                        <>
                          <Button
                            size="sm"
                            color="info"
                            outline={info.stageSize <= 1}
                            onClick={() => toggleParallel(agent.id)}
                            disabled={info.stageSize === 1 && info.stageIdx === 0}
                            title={info.stageSize > 1 ? "Split into its own step" : "Merge into the step before it (run in parallel)"}
                          >
                            ∥
                          </Button>
                          <Button size="sm" color="link" onClick={() => moveAgent(agent.id, -1)} disabled={info.stageIdx === 0}>
                            <i className="mdi mdi-arrow-up"></i>
                          </Button>
                          <Button size="sm" color="link" onClick={() => moveAgent(agent.id, 1)} disabled={info.stageIdx === stages.length - 1}>
                            <i className="mdi mdi-arrow-down"></i>
                          </Button>
                        </>
                      )}
                    </div>
                  )
                })
              })()}
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>Cron Expression (optional)</Label>
              <Input type="text" name="cronExpression" value={form.cronExpression} onChange={handleChange} placeholder="0 9 * * * (daily at 9am)" />
              <small className="text-muted">
                Examples: <code>0 * * * *</code> hourly · <code>0 9 * * *</code> daily 9am · <code>0 9 * * 1</code> weekly Monday 9am. Leave blank for manual-run only.
              </small>
            </FormGroup>
            <div className="form-check">
              <input type="checkbox" className="form-check-input" id="enabled" name="enabled" checked={form.enabled} onChange={handleChange} />
              <label className="form-check-label" htmlFor="enabled">Enabled</label>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button color="secondary" outline type="button" onClick={close}>Cancel</Button>
            <Button color="primary" type="submit" disabled={saving || !form.agentIds.length || Boolean(mechanicalError)}>{saving ? "Saving..." : "Save"}</Button>
          </ModalFooter>
        </Form>
      </Modal>

      <ChartLightbox url={lightboxUrl} isOpen={Boolean(lightboxUrl)} toggle={() => setLightboxUrl(null)} />
    </React.Fragment>
  )
}

export default Workflows

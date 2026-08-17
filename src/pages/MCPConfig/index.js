import React, { useState, useEffect } from "react"
import {
  Container, Row, Col, Card, CardBody, Badge, Button, Spinner, Alert,
  Modal, ModalHeader, ModalBody, ModalFooter, Form, FormGroup, Label, Input,
} from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import {
  listMcps, createMcp, updateMcp, deleteMcp, listMcpTools, callMcpTool,
} from "../../helpers/connector_helper"

const EMPTY_FORM = { name: "", url: "", description: "" }

/** A blank args object shaped from a tool's JSON schema, so the tester starts pre-filled. */
const skeletonFor = (inputSchema) => {
  const props = inputSchema?.properties || {}
  const obj = {}
  for (const [key, prop] of Object.entries(props)) {
    if (prop.default !== undefined) obj[key] = prop.default
    else if (prop.type === "number" || prop.type === "integer") obj[key] = 0
    else if (prop.type === "boolean") obj[key] = false
    else obj[key] = ""
  }
  return obj
}

const MCPConfig = () => {
  const [mcps, setMcps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [expanded, setExpanded] = useState(null) // mcp id currently expanded
  const [tools, setTools] = useState([])
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsError, setToolsError] = useState(null)

  const [selectedTool, setSelectedTool] = useState(null)
  const [argsText, setArgsText] = useState("{}")
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState(null)

  const [editing, setEditing] = useState(null) // null = closed, {} = new, {...} = editing
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const data = await listMcps()
      setMcps(data.mcps || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const closeTester = () => {
    setSelectedTool(null)
    setRunResult(null)
    setArgsText("{}")
  }

  const toggleExpand = async (mcp) => {
    if (expanded === mcp.id) {
      setExpanded(null)
      setTools([])
      closeTester()
      return
    }
    setExpanded(mcp.id)
    setTools([])
    closeTester()
    try {
      setToolsLoading(true)
      setToolsError(null)
      const data = await listMcpTools(mcp.id)
      setTools(data.tools || [])
    } catch (err) {
      setToolsError(err.message)
    } finally {
      setToolsLoading(false)
    }
  }

  const pickTool = (tool) => {
    setSelectedTool(tool)
    setRunResult(null)
    setArgsText(JSON.stringify(skeletonFor(tool.inputSchema), null, 2))
  }

  const runTool = async (mcpId) => {
    let args
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {}
    } catch {
      setRunResult({ error: "Arguments must be valid JSON" })
      return
    }
    try {
      setRunning(true)
      setRunResult(null)
      const data = await callMcpTool(mcpId, selectedTool.name, args)
      setRunResult(data)
    } catch (err) {
      setRunResult({ error: err.message })
    } finally {
      setRunning(false)
    }
  }

  const openNew = () => { setForm(EMPTY_FORM); setEditing({}) }
  const openEdit = (mcp) => {
    setForm({ name: mcp.name, url: mcp.url, description: mcp.description || "" })
    setEditing(mcp)
  }
  const closeModal = () => setEditing(null)

  const handleChange = (e) => {
    const { name, value } = e.target
    setForm({ ...form, [name]: value })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      setError(null)
      if (editing?.id) await updateMcp(editing.id, form)
      else await createMcp(form)
      closeModal()
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (mcp) => {
    try {
      await deleteMcp(mcp.id)
      if (expanded === mcp.id) { setExpanded(null); setTools([]); closeTester() }
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="MCP Config" />

          {error && <Alert color="danger">{error}</Alert>}

          <Row className="mb-3">
            <Col>
              <p className="text-muted mb-0">
                Built-in MCPs are always available. Add any other MCP server by URL to list its tools and run test calls against it.
              </p>
            </Col>
            <Col className="d-flex justify-content-end">
              <Button color="primary" onClick={openNew}>
                <i className="mdi mdi-plus me-1"></i>Add MCP
              </Button>
            </Col>
          </Row>

          <Row>
            {mcps.map((mcp) => {
              const isOpen = expanded === mcp.id
              return (
                <Col md="12" key={mcp.id} className="mb-3">
                  <Card>
                    <CardBody>
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <h5 className="card-title mb-1">
                            {mcp.name}{" "}
                            {mcp.builtin
                              ? <Badge color="info">built-in</Badge>
                              : <Badge color="secondary">remote</Badge>}
                          </h5>
                          <p className="text-muted small mb-1">{mcp.description}</p>
                          {mcp.url && <p className="text-muted small mb-0"><code>{mcp.url}</code></p>}
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" color="primary" outline onClick={() => toggleExpand(mcp)}>
                            {isOpen ? "Hide tools" : "Test / Run"}
                          </Button>
                          {!mcp.builtin && (
                            <>
                              <Button size="sm" color="secondary" outline onClick={() => openEdit(mcp)}>
                                <i className="mdi mdi-pencil"></i>
                              </Button>
                              <Button size="sm" color="danger" outline onClick={() => handleDelete(mcp)}>
                                <i className="mdi mdi-delete"></i>
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {isOpen && (
                        <div className="mt-3 border-top pt-3">
                          {toolsLoading && <Spinner size="sm" />}
                          {toolsError && <Alert color="danger">{toolsError}</Alert>}

                          {!toolsLoading && !toolsError && (
                            <Row>
                              <Col md="4">
                                <div className="list-group">
                                  {tools.map((tool) => (
                                    <button
                                      key={tool.name}
                                      type="button"
                                      className={`list-group-item list-group-item-action${selectedTool?.name === tool.name ? " active" : ""}`}
                                      onClick={() => pickTool(tool)}
                                    >
                                      <div className="fw-bold">{tool.title || tool.name}</div>
                                      <div className="small text-muted">{tool.description}</div>
                                    </button>
                                  ))}
                                  {!tools.length && <p className="text-muted small">No tools reported by this MCP.</p>}
                                </div>
                              </Col>
                              <Col md="8">
                                {selectedTool ? (
                                  <>
                                    <Label>Arguments (JSON) — prompt / test payload for {selectedTool.name}</Label>
                                    <Input
                                      type="textarea"
                                      rows={8}
                                      value={argsText}
                                      onChange={(e) => setArgsText(e.target.value)}
                                      className="mb-2 font-monospace"
                                    />
                                    <Button color="success" onClick={() => runTool(mcp.id)} disabled={running}>
                                      {running ? "Running..." : "Run tool"}
                                    </Button>

                                    {runResult && (
                                      <pre className="mt-3 p-2 bg-light border rounded small" style={{ whiteSpace: "pre-wrap" }}>
                                        {JSON.stringify(runResult, null, 2)}
                                      </pre>
                                    )}
                                  </>
                                ) : (
                                  <p className="text-muted">Select a tool on the left to test it.</p>
                                )}
                              </Col>
                            </Row>
                          )}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </Col>
              )
            })}
          </Row>
        </Container>
      </div>

      <Modal isOpen={Boolean(editing)} toggle={closeModal}>
        <ModalHeader toggle={closeModal}>{editing?.id ? "Edit MCP" : "Add MCP"}</ModalHeader>
        <Form onSubmit={handleSave}>
          <ModalBody>
            <FormGroup className="mb-3">
              <Label>Name</Label>
              <Input type="text" name="name" value={form.name} onChange={handleChange} required />
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>MCP Server URL</Label>
              <Input
                type="url"
                name="url"
                value={form.url}
                onChange={handleChange}
                required
                placeholder="https://example.com/mcp"
              />
            </FormGroup>
            <FormGroup className="mb-3">
              <Label>Description (optional)</Label>
              <Input type="textarea" name="description" rows={3} value={form.description} onChange={handleChange} />
            </FormGroup>
          </ModalBody>
          <ModalFooter>
            <Button color="secondary" outline type="button" onClick={closeModal}>Cancel</Button>
            <Button color="primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          </ModalFooter>
        </Form>
      </Modal>
    </React.Fragment>
  )
}

export default MCPConfig

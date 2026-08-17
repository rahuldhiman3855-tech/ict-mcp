import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Form, FormGroup, Label, Input, Button, Spinner, Alert } from "reactstrap"
import Breadcrumb from "../../components/Common/Breadcrumb"
import { getSettings, saveSettings } from "../../helpers/connector_helper"

const Settings = () => {
  const [form, setForm] = useState({
    webhookUrl: "",
    accountEquity: 100000,
    riskPerTrade: 0.005,
    stopAtrMult: 1.5,
    retestZoneAtrMult: 0.25,
    retestExpiryCandles: 12,
    exitMode: "fixed_2r",
    maxTradesPerDay: 3,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setLoading(true)
        const data = await getSettings()
        setForm((f) => ({ ...f, ...data }))
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadSettings()
  }, [])

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value })

  const handleSave = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      setError(null)
      setSuccess(null)
      await saveSettings(form)
      setSuccess("Settings saved.")
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Breadcrumb title="Dashboard" breadcrumbItem="Settings" />

          {error && <Alert color="danger">{error}</Alert>}
          {success && <Alert color="success">{success}</Alert>}

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Notification Settings</h5>
                  <p className="text-muted small">
                    Every workflow run sends a notification on whichever channel(s) below are configured.
                    Telegram bot token and subscribers are managed on the{" "}
                    <a href="/subscription">Subscription</a> page.
                  </p>
                  <Form onSubmit={handleSave}>
                    <FormGroup className="mb-3">
                      <Label>Webhook URL</Label>
                      <Input type="text" name="webhookUrl" value={form.webhookUrl || ""} onChange={handleChange} />
                    </FormGroup>
                    <Button color="primary" type="submit" disabled={saving}>
                      {saving ? "Saving..." : "Save Settings"}
                    </Button>
                  </Form>
                </CardBody>
              </Card>
            </Col>
          </Row>

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Mechanical Agent</h5>
                  <p className="text-muted small">
                    Shared parameters for the mechanical agent — one global config, used by every workflow that includes it.
                  </p>
                  <Form onSubmit={handleSave}>
                    <Row>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Account Equity</Label>
                          <Input type="number" step="1000" min="0" name="accountEquity" value={form.accountEquity ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Risk per Trade (0–0.1)</Label>
                          <Input type="number" step="0.001" min="0" max="0.1" name="riskPerTrade" value={form.riskPerTrade ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Stop (× ATR)</Label>
                          <Input type="number" step="0.1" min="0" name="stopAtrMult" value={form.stopAtrMult ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Retest Zone (× ATR)</Label>
                          <Input type="number" step="0.05" min="0" name="retestZoneAtrMult" value={form.retestZoneAtrMult ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Retest Expiry (candles)</Label>
                          <Input type="number" step="1" min="1" name="retestExpiryCandles" value={form.retestExpiryCandles ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Exit Mode</Label>
                          <Input type="select" name="exitMode" value={form.exitMode || "fixed_2r"} onChange={handleChange}>
                            <option value="fixed_2r">Fixed 2R</option>
                            <option value="trailing">Breakeven + ATR Trailing</option>
                          </Input>
                        </FormGroup>
                      </Col>
                      <Col md="6">
                        <FormGroup className="mb-3">
                          <Label>Max Trades / Day</Label>
                          <Input type="number" step="1" min="1" name="maxTradesPerDay" value={form.maxTradesPerDay ?? ""} onChange={handleChange} />
                        </FormGroup>
                      </Col>
                    </Row>
                    <Button color="primary" type="submit" disabled={saving}>
                      {saving ? "Saving..." : "Save Settings"}
                    </Button>
                  </Form>
                </CardBody>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Settings

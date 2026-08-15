import React, { useState, useEffect } from "react"
import { Container, Row, Col, Card, CardBody, Spinner, Alert } from "reactstrap"
import Chart from "react-apexcharts"
import { getSignals, getRunDetails } from "../../helpers/connector_helper"

const Analytics = () => {
  const [stats, setStats] = useState([])
  const [runsPerDay, setRunsPerDay] = useState([])
  const [successFailure, setSuccessFailure] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        setLoading(true)
        const signals = await getSignals({ limit: 500 })
        const signalList = signals.signals || []

        // Calculate stats
        const totalSignals = signalList.length
        const buySignals = signalList.filter(s => s.verdict === "BUY").length
        const sellSignals = signalList.filter(s => s.verdict === "SELL").length
        const avgConfidence = totalSignals > 0
          ? (signalList.reduce((sum, s) => sum + (s.confidence || 0), 0) / totalSignals * 100).toFixed(1)
          : 0

        setStats([
          { title: "Total Signals", value: totalSignals, icon: "mdi mdi-chart-line", color: "primary", change: "All time" },
          { title: "BUY Signals", value: buySignals, icon: "mdi mdi-trending-up", color: "success", change: "Active" },
          { title: "SELL Signals", value: sellSignals, icon: "mdi mdi-trending-down", color: "danger", change: "Active" },
          { title: "Avg Confidence", value: `${avgConfidence}%`, icon: "mdi mdi-percent", color: "info", change: "Mean" },
        ])

        // Group signals by date
        const byDate = {}
        signalList.forEach(sig => {
          const date = new Date(sig.at).toLocaleDateString()
          byDate[date] = (byDate[date] || 0) + 1
        })

        const last7Days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date()
          d.setDate(d.getDate() - (6 - i))
          return d.toLocaleDateString()
        })

        const runsData = last7Days.map(date => ({
          date,
          runs: byDate[date] || 0,
        }))
        setRunsPerDay(runsData)

        // Success/failure
        setSuccessFailure([
          { status: "Success", count: signalList.filter(s => s.verdict && s.verdict !== "HOLD").length },
          { status: "Hold/Neutral", count: signalList.filter(s => !s.verdict || s.verdict === "HOLD").length },
        ])
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadAnalytics()
  }, [])

  if (loading) return <Spinner />
  if (error) return <Alert color="danger">{error}</Alert>

  const lineChartOptions = {
    chart: { type: "line", toolbar: { show: false } },
    colors: ["#3b82f6"],
    stroke: { curve: "smooth", width: 2 },
    xaxis: { categories: runsPerDay.map((d) => d.date) },
    yaxis: { title: { text: "Number of Signals" } },
    grid: { borderColor: "#e5e7eb" },
  }

  const donutChartOptions = {
    chart: { type: "donut" },
    colors: ["#10b981", "#fbbf24"],
    labels: successFailure.map((s) => s.status),
    legend: { position: "bottom" },
  }

  const lineChartSeries = [
    { name: "Signals", data: runsPerDay.map((d) => d.runs) },
  ]

  const donutChartSeries = successFailure.map((s) => s.count)

  return (
    <React.Fragment>
      <div className="page-content">
        <Container fluid>
          <Row className="mb-3">
            <Col sm="12">
              <div className="page-title-box">
                <h4 className="mb-0">Analytics & Performance</h4>
              </div>
            </Col>
          </Row>

          <Row className="mb-4">
            {stats.map((stat, idx) => (
              <Col lg="3" md="6" key={idx} className="mb-3">
                <Card>
                  <CardBody>
                    <div className="d-flex align-items-center justify-content-between mb-2">
                      <div>
                        <p className="text-muted mb-0 text-uppercase fw-semibold fs-12">
                          {stat.title}
                        </p>
                      </div>
                      <div className={`avatar-sm rounded-circle bg-light-${stat.color}`}>
                        <i
                          className={`${stat.icon} text-${stat.color} fs-5`}
                        ></i>
                      </div>
                    </div>
                    <div className="mt-2">
                      <h4 className="mb-2">{stat.value}</h4>
                      <small className="text-muted">{stat.change}</small>
                    </div>
                  </CardBody>
                </Card>
              </Col>
            ))}
          </Row>

          <Row>
            <Col lg="8">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Runs Per Day</h5>
                  <Chart
                    options={lineChartOptions}
                    series={lineChartSeries}
                    type="line"
                    height="300"
                  />
                </CardBody>
              </Card>
            </Col>

            <Col lg="4">
              <Card>
                <CardBody>
                  <h5 className="card-title mb-3">Success / Failure</h5>
                  <Chart
                    options={donutChartOptions}
                    series={donutChartSeries}
                    type="donut"
                    height="300"
                  />
                </CardBody>
              </Card>
            </Col>
          </Row>
        </Container>
      </div>
    </React.Fragment>
  )
}

export default Analytics

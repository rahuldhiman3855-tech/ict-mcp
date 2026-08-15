-- =========================================
-- ICT Cron Manager Database Schema Setup
-- =========================================
-- Run this against the host/database/user/password configured in .env
-- (DB_HOST / DB_NAME / DB_USER / DB_PASSWORD)

-- Drop all existing tables (clean slate)
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS dashboard_config;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS cron_jobs;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS watchlist;
DROP TABLE IF EXISTS users;

-- =========================================
-- Core Tables
-- =========================================

-- Users and authentication
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'trader',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX(email)
);

-- Dashboard configuration and UI state
CREATE TABLE dashboard_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  config JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY(user_id)
);

-- MCP agents registry
CREATE TABLE agents (
  id VARCHAR(100) PRIMARY KEY,
  type VARCHAR(50),
  name VARCHAR(255),
  description TEXT,
  config JSON,
  enabled BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Cron job definitions
CREATE TABLE cron_jobs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  agent_id VARCHAR(100),
  schedule VARCHAR(100),
  enabled BOOLEAN DEFAULT 1,
  config JSON,
  last_run TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX(enabled, last_run)
);

-- Trading signals (moved from JSONL to MySQL)
CREATE TABLE signals (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  verdict VARCHAR(20),
  confidence FLOAT,
  agents JSON,
  tokens_total INT,
  at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX(symbol, at DESC),
  INDEX(at DESC)
);

-- Signal run logs and details
CREATE TABLE runs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  workflow_id VARCHAR(100),
  status VARCHAR(50),
  result JSON,
  started_at TIMESTAMP NULL,
  ended_at TIMESTAMP NULL,
  duration_ms INT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX(symbol, created_at DESC),
  INDEX(created_at DESC),
  INDEX(status)
);

-- Settings (alerts, telegram config, thresholds)
CREATE TABLE settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  key VARCHAR(100) NOT NULL,
  value JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY(user_id, key),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Watchlist symbols
CREATE TABLE watchlist (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL UNIQUE,
  label VARCHAR(255),
  class VARCHAR(50),
  enabled BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX(enabled)
);

-- =========================================
-- Seed Initial Data
-- =========================================

-- Insert default watchlist symbols
INSERT INTO watchlist (symbol, label, class) VALUES
  ('EURUSD', 'EUR/USD', 'FOREX'),
  ('GBPUSD', 'GBP/USD', 'FOREX'),
  ('USDJPY', 'USD/JPY', 'FOREX'),
  ('AUDUSD', 'AUD/USD', 'FOREX'),
  ('NZDUSD', 'NZD/USD', 'FOREX');

-- Insert default agents
INSERT INTO agents (id, type, name, config, enabled) VALUES
  ('lstm_predictor', 'ml', 'LSTM Predictor', '{"model": "time-series"}', 1),
  ('ichimoku_analyzer', 'tech', 'Ichimoku Analyzer', '{"period": 26}', 1),
  ('rsi_detector', 'tech', 'RSI Detector', '{"period": 14, "overbought": 70, "oversold": 30}', 1),
  ('macd_analyzer', 'tech', 'MACD Analyzer', '{"fast": 12, "slow": 26}', 1),
  ('support_resistance', 'struct', 'Support & Resistance', '{"window": 50}', 1),
  ('trend_filter', 'tech', 'Trend Filter', '{"ma_period": 50}', 1),
  ('signal_aggregator', 'ml', 'Signal Aggregator', '{"method": "weighted_vote"}', 1);

-- Insert default cron jobs (hourly runs)
INSERT INTO cron_jobs (agent_id, schedule, enabled, config) VALUES
  ('lstm_predictor', '0 * * * *', 1, '{"timeout_ms": 30000}'),
  ('ichimoku_analyzer', '0 * * * *', 1, '{"timeout_ms": 20000}'),
  ('rsi_detector', '0 * * * *', 1, '{"timeout_ms": 15000}'),
  ('macd_analyzer', '0 * * * *', 1, '{"timeout_ms": 15000}'),
  ('support_resistance', '0 * * * *', 1, '{"timeout_ms": 20000}'),
  ('trend_filter', '0 * * * *', 1, '{"timeout_ms": 10000}'),
  ('signal_aggregator', '0 * * * *', 1, '{"timeout_ms": 10000}');

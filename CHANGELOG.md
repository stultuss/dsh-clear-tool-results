# Changelog

本项目自 0.3.0 起遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。

## [0.3.0] - 2026-09-04

### 新增

- 兼容新 Harness 核心 ≥ **0.1.2-rc.1**：新核心把会话事件数组从 `session.events` 迁移到 `session.log`，新增 `eventsOf()` 兼容读取（优先 `session.log`，回退 `session.events`），同一份代码同时支持新旧两代核心，无需按环境区分。

### 修复

- 新核心下 `turn/end` 归档时读取 `session.events` 抛 TypeError，导致工具结果不再归档、无法从上下文清除（插件仍能挂载、工具仍能注册，属静默失效）。

## 0.2.1 及更早版本

0.2.1 之前未维护 changelog，历史变更请参见 git 提交记录（0.1.7 → 0.2.0 → 0.2.1）。

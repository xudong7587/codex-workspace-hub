(() => {
  "use strict";

  const TOKEN_STORAGE_KEY = "vwatch-quota-hub.admin-token";
  const THEME_STORAGE_KEY = "vwatch-quota-hub.theme";
  const STATIC_PROVIDER_IDS = ["codex", "openrouter"];
  const THEME_ORDER = ["system", "light", "dark"];

  let currentState = null;
  let toastTimer = null;
  let toastHideTimer = null;
  let alertTimer = null;
  let codexLoginTimer = null;
  let codexLoginActive = false;
  let codexLoginStartedAt = 0;
  let codexLoginGeneration = 0;
  let codexLoginId = null;

  const byId = (id) => document.getElementById(id);

  function getStoredToken() {
    try {
      return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storeToken(token) {
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      return true;
    } catch {
      return false;
    }
  }

  function clearToken() {
    try {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      return;
    }
  }

  function getStoredTheme() {
    try {
      const theme = window.sessionStorage.getItem(THEME_STORAGE_KEY);
      return THEME_ORDER.includes(theme) ? theme : "system";
    } catch {
      return "system";
    }
  }

  function applyTheme(theme) {
    const selected = THEME_ORDER.includes(theme) ? theme : "system";
    if (selected === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = selected;
    }

    const labels = {
      system: "外观：系统",
      light: "外观：浅色",
      dark: "外观：深色"
    };
    byId("themeButton").textContent = labels[selected];
    byId("themeButton").dataset.theme = selected;

    try {
      window.sessionStorage.setItem(THEME_STORAGE_KEY, selected);
    } catch {
      return;
    }
  }

  function cycleTheme() {
    const current = byId("themeButton").dataset.theme || "system";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    applyTheme(next);
  }

  async function api(path, options = {}) {
    const token = getStoredToken();
    if (!token) {
      const error = new Error("管理会话已过期，请重新登录。");
      error.isAuthError = true;
      throw error;
    }

    const headers = {
      Accept: "application/json",
      "X-Requested-With": "VWatch-Quota-Hub",
      ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
      Authorization: `Bearer ${token}`
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        credentials: "same-origin"
      });
    } catch {
      throw new Error("无法连接 Hub，请检查网络和服务状态。");
    }

    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const message = extractErrorMessage(data) || `请求失败，HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.isAuthError = response.status === 401 || response.status === 403;
      throw error;
    }

    return data || {};
  }

  async function publicApi(path, options = {}) {
    const headers = {
      Accept: "application/json",
      "X-Requested-With": "VWatch-Quota-Hub"
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        credentials: "same-origin"
      });
    } catch {
      throw new Error("无法连接 Hub，请检查网络和服务状态。");
    }
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const error = new Error(extractErrorMessage(data) || `请求失败，HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  }

  function extractErrorMessage(data) {
    if (!data || typeof data !== "object") {
      return "";
    }
    if (typeof data.message === "string") {
      return data.message;
    }
    if (typeof data.error === "string") {
      return data.error;
    }
    if (data.error && typeof data.error.message === "string") {
      return data.error.message;
    }
    return "";
  }

  function setButtonBusy(button, busy, label) {
    if (!button) {
      return;
    }
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
      delete button.dataset.originalLabel;
    }
  }

  function setFormMessage(id, message, type = "") {
    const element = byId(id);
    element.textContent = message || "";
    element.classList.toggle("is-error", type === "error");
    element.classList.toggle("is-success", type === "success");
  }

  function showToast(message) {
    const toast = byId("toast");
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    toast.classList.remove("is-hiding");
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.classList.add("is-hiding");
      toastHideTimer = window.setTimeout(() => {
        toast.hidden = true;
        toast.classList.remove("is-hiding");
      }, 180);
    }, 3020);
  }

  function showGlobalAlert(message, type = "", duration = 5000) {
    const alert = byId("globalAlert");
    window.clearTimeout(alertTimer);
    alert.textContent = message;
    alert.className = "global-alert";
    if (type) {
      alert.classList.add(`is-${type}`);
    }
    alert.hidden = false;
    if (duration > 0) {
      alertTimer = window.setTimeout(() => {
        alert.hidden = true;
      }, duration);
    }
  }

  function showLogin(message = "", messageType = "error") {
    byId("appView").hidden = true;
    byId("loginView").hidden = false;
    byId("setupContent").hidden = true;
    byId("loginContent").hidden = false;
    setFormMessage("authMessage", message, message ? messageType : "");
    byId("adminToken").value = "";
    window.setTimeout(() => byId("adminToken").focus(), 0);
  }

  function showSetup(message = "") {
    byId("appView").hidden = true;
    byId("loginView").hidden = false;
    byId("loginContent").hidden = true;
    byId("setupContent").hidden = false;
    setFormMessage("setupMessage", message, message ? "error" : "");
    byId("setupPassword").value = "";
    byId("setupPasswordConfirm").value = "";
    window.setTimeout(() => byId("setupPassword").focus(), 0);
  }

  function showAppLoading() {
    byId("loginView").hidden = true;
    byId("appView").hidden = false;
    byId("loadingState").hidden = false;
    byId("errorState").hidden = true;
    byId("appContent").hidden = true;
    updateTopStatus("正在读取状态", "busy");
  }

  function showAppError(message) {
    byId("loadingState").hidden = true;
    byId("appContent").hidden = true;
    byId("errorState").hidden = false;
    byId("errorStateMessage").textContent = message;
    updateTopStatus("连接失败", "error");
  }

  function showAppContent() {
    byId("loadingState").hidden = true;
    byId("errorState").hidden = true;
    byId("appContent").hidden = false;
  }

  function updateTopStatus(text, state) {
    byId("topStatusText").textContent = text;
    const indicator = byId("topStatusIndicator");
    indicator.className = "status-indicator";
    if (state) {
      indicator.classList.add(`is-${state}`);
    }
  }

  async function loadState({ initial = false, announce = false } = {}) {
    if (initial) {
      showAppLoading();
    }

    try {
      const state = await api("/admin/api/state");
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("Hub 返回了无法识别的管理状态。");
      }
      currentState = state;
      renderState(state);
      showAppContent();
      if (announce) {
        showGlobalAlert("状态已更新。", "success", 2500);
      }
      return state;
    } catch (error) {
      if (error.isAuthError) {
        clearToken();
        showLogin("管理会话无效或已失效，请重新登录。", "error");
        return null;
      }
      showAppError(error.message || "暂时无法读取管理状态。");
      return null;
    }
  }

  function renderState(state) {
    const settings = state.settings && typeof state.settings === "object" ? state.settings : {};
    const bridge = state.bridge && typeof state.bridge === "object" ? state.bridge : {};
    const providers = Array.isArray(state.providers) ? state.providers.filter(isProvider) : [];

    const pollInterval = toFiniteNumber(settings.pollIntervalSeconds, 300);
    const staleAfter = toFiniteNumber(settings.staleAfterSeconds, 900);
    const refreshWindowStart = typeof settings.refreshWindowStart === "string"
      ? settings.refreshWindowStart
      : "00:00";
    const refreshWindowEnd = typeof settings.refreshWindowEnd === "string"
      ? settings.refreshWindowEnd
      : "00:00";
    byId("pollIntervalSeconds").value = String(pollInterval);
    byId("staleAfterSeconds").value = String(staleAfter);
    byId("refreshWindowStart").value = refreshWindowStart;
    byId("refreshWindowEnd").value = refreshWindowEnd;
    byId("hubPollInterval").textContent = formatDuration(pollInterval);
    byId("hubStaleInterval").textContent = formatDuration(staleAfter);
    const refreshWindowLabel = refreshWindowStart === refreshWindowEnd
      ? "全天"
      : `${refreshWindowStart}–${refreshWindowEnd}`;
    byId("hubRefreshWindow").textContent = state.schedule?.active === false
      ? `${refreshWindowLabel}（暂停中）`
      : refreshWindowLabel;
    byId("providerCount").textContent = String(providers.length);
    byId("hubMemoryUsage").textContent = state.runtime && Number.isFinite(Number(state.runtime.rssBytes))
      ? formatBytes(Number(state.runtime.rssBytes))
      : "未提供";

    const enabledProviders = providers.filter((provider) => provider.enabled);
    byId("enabledProviderCount").textContent = `${enabledProviders.length} 个连接`;
    byId("latestUpdateTime").textContent = findLatestUpdate(providers);

    const hubStatus = getHubStatus(state, providers);
    setBadge(byId("hubStatusBadge"), hubStatus);
    updateTopStatus(hubStatus.text === "正常" ? "Hub 正常运行" : `Hub ${hubStatus.text}`, hubStatus.topState);

    renderBridge(bridge, providers);
    renderProviders(providers);
  }

  function isProvider(value) {
    return Boolean(value && typeof value === "object" && typeof value.id === "string");
  }

  function getHubStatus(state, providers) {
    if (state.ready === false || state.healthy === false) {
      return statusDescriptor("error");
    }
    if (typeof state.status === "string") {
      return statusDescriptor(state.status);
    }
    if (providers.some((provider) => provider.enabled && isErrorStatus(provider.status))) {
      return { text: "部分异常", badgeClass: "badge-warning", topState: "busy" };
    }
    return statusDescriptor("ok");
  }

  function renderBridge(bridge, providers) {
    const endpoint = window.location.origin;
    byId("bridgeEndpoint").textContent = endpoint;
    byId("bridgeEndpoint").dataset.copyValue = endpoint;

    const bridgeSecret = typeof bridge.secret === "string" ? bridge.secret : "";
    byId("bridgeSecret").textContent = bridgeSecret || "尚未生成";
    byId("bridgeSecret").dataset.copyValue = bridgeSecret;
    byId("copyBridgeSecretButton").disabled = !bridgeSecret;

    const compatibleCount = providers.filter((provider) => provider.enabled && provider.bridgeCompatible === true).length;
    byId("bridgeProviderCount").textContent = `${compatibleCount} 个`;

    let bridgeStatus;
    if (typeof bridge.status === "string") {
      bridgeStatus = statusDescriptor(bridge.status);
    } else if (bridge.ready === false) {
      bridgeStatus = { text: "等待额度", badgeClass: "badge-warning", topState: "busy" };
    } else if (bridge.healthy === false || bridge.secretConfigured === false) {
      bridgeStatus = statusDescriptor("error");
    } else {
      bridgeStatus = statusDescriptor("ok");
    }
    setBadge(byId("bridgeStatusBadge"), bridgeStatus);
  }

  function renderProviders(providers) {
    const providerMap = new Map(providers.map((provider) => [provider.id.toLowerCase(), provider]));

    for (const id of STATIC_PROVIDER_IDS) {
      const provider = providerMap.get(id);
      const card = byId(`provider-${id}`);
      card.hidden = !provider;
      if (provider) {
        renderKnownProvider(id, provider);
      }
    }

    document.querySelectorAll(".provider-card-generic").forEach((card) => card.remove());
    for (const provider of providers) {
      const id = provider.id.toLowerCase();
      if (!STATIC_PROVIDER_IDS.includes(id) && id !== "deepseek") {
        byId("providerList").append(createGenericProviderCard(provider));
      }
    }

    byId("providersEmptyState").hidden = providers.length > 0;
  }

  function renderKnownProvider(id, provider) {
    const config = provider.config && typeof provider.config === "object" ? provider.config : {};
    byId(`${id}DisplayName`).textContent = provider.displayName || provider.id;
    byId(`${id}Enabled`).checked = Boolean(provider.enabled);
    const codexNeedsLogin = id === "codex" && !provider.updatedAt && /尚未登录/.test(String(provider.error || ""));
    const configured = Boolean(provider.configured) && !codexNeedsLogin;
    byId(`${id}Configured`).textContent = configured ? "凭据已配置" : id === "codex" ? "需要登录" : "需要配置";
    byId(`${id}UpdatedAt`).textContent = provider.updatedAt ? `更新于 ${formatDateTime(provider.updatedAt)}` : "尚未更新";

    const visibleStatus = codexNeedsLogin ? "unconfigured" : provider.enabled ? provider.status : "disabled";
    const status = statusDescriptor(visibleStatus, configured);
    setBadge(byId(`${id}StatusBadge`), status);
    setCompatibilityBadge(byId(`${id}Compatibility`), provider.bridgeCompatible);

    const errorElement = byId(`${id}Error`);
    if (provider.error) {
      errorElement.textContent = String(provider.error);
      errorElement.hidden = false;
    } else {
      errorElement.textContent = "";
      errorElement.hidden = true;
    }

    const metrics = id === "codex" && provider.accountLabel
      ? [{ label: "账户", value: provider.accountLabel }, ...(Array.isArray(provider.metrics) ? provider.metrics : [])]
      : provider.metrics;
    renderMetrics(byId(`${id}Metrics`), metrics, provider.status);
    byId(`${id}RefreshButton`).disabled = !provider.enabled || !provider.configured;

    if (id === "codex") {
      byId("codexConnectButton").textContent = configured ? "重新连接账号" : "连接账号";
    }
    if (id === "openrouter") {
      const configuredMode = typeof config.mode === "string" ? config.mode : "credits";
      byId("openrouterMode").value = configuredMode === "key" ? "key" : "credits";
      byId("openrouterApiKey").placeholder = provider.configured ? "已配置，留空以保留" : "输入 OpenRouter API Key";
      byId("openrouterClearKeyButton").hidden = !provider.configured;
      updateOpenRouterKeyHelp();
    }
  }

  function createGenericProviderCard(provider) {
    const article = document.createElement("article");
    article.className = "surface provider-card provider-card-generic";

    const heading = document.createElement("div");
    heading.className = "provider-heading";
    const headingCopy = document.createElement("div");
    const titleRow = document.createElement("div");
    titleRow.className = "provider-title-row";
    const title = document.createElement("h3");
    title.textContent = provider.displayName || provider.id;
    const compatibility = document.createElement("span");
    setCompatibilityBadge(compatibility, provider.bridgeCompatible);
    titleRow.append(title, compatibility);
    const description = document.createElement("p");
    description.textContent = "此连接器由 Hub 管理，当前面板仅显示其运行状态。";
    headingCopy.append(titleRow, description);
    const status = document.createElement("span");
    setBadge(status, statusDescriptor(provider.enabled ? provider.status : "disabled", provider.configured));
    heading.append(headingCopy, status);

    const body = document.createElement("div");
    body.className = "provider-body";
    const metrics = document.createElement("div");
    metrics.className = "metric-region";
    renderMetrics(metrics, provider.metrics, provider.status);
    body.append(metrics);
    if (provider.error) {
      const error = document.createElement("p");
      error.className = "provider-error";
      error.textContent = String(provider.error);
      body.append(error);
    }

    const footer = document.createElement("footer");
    footer.className = "provider-footer";
    const configured = document.createElement("span");
    configured.textContent = provider.configured ? "凭据已配置" : "需要配置";
    const updated = document.createElement("span");
    updated.textContent = provider.updatedAt ? `更新于 ${formatDateTime(provider.updatedAt)}` : "尚未更新";
    footer.append(configured, updated);

    article.append(heading, body, footer);
    return article;
  }

  function setCompatibilityBadge(element, bridgeCompatible) {
    element.className = "badge";
    if (bridgeCompatible === true) {
      element.textContent = "可同步到手表";
      element.classList.add("badge-success");
    } else if (bridgeCompatible === false) {
      element.textContent = "仅面板可见";
      element.classList.add("badge-warning");
    } else {
      element.textContent = "兼容性未知";
      element.classList.add("badge-neutral");
    }
  }

  function setBadge(element, descriptor) {
    element.className = `badge ${descriptor.badgeClass}`;
    element.textContent = descriptor.text;
  }

  function statusDescriptor(rawStatus, configured = true) {
    const status = String(rawStatus || "unknown").toLowerCase();
    if (["ok", "healthy", "success", "connected", "ready", "available"].includes(status)) {
      return { text: "正常", badgeClass: "badge-success", topState: "ok" };
    }
    if (["refreshing", "loading", "pending", "connecting", "busy"].includes(status)) {
      return { text: "更新中", badgeClass: "badge-warning", topState: "busy" };
    }
    if (["stale", "expired"].includes(status)) {
      return { text: "数据过期", badgeClass: "badge-warning", topState: "busy" };
    }
    if (["error", "failed", "unavailable", "offline"].includes(status)) {
      return { text: "异常", badgeClass: "badge-danger", topState: "error" };
    }
    if (["disabled", "off"].includes(status)) {
      return { text: "已停用", badgeClass: "badge-neutral", topState: "busy" };
    }
    if (!configured || ["unconfigured", "disconnected"].includes(status)) {
      return { text: "未连接", badgeClass: "badge-neutral", topState: "busy" };
    }
    return { text: "等待数据", badgeClass: "badge-neutral", topState: "busy" };
  }

  function isErrorStatus(status) {
    return ["error", "failed", "unavailable", "offline"].includes(String(status || "").toLowerCase());
  }

  function renderMetrics(container, metrics, status) {
    container.replaceChildren();
    const rows = extractMetricRows(metrics).slice(0, 8);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty-metric";
      empty.textContent = isErrorStatus(status) ? "本次没有可用额度数据" : "尚无额度数据，完成配置后刷新即可查看";
      container.append(empty);
      return;
    }

    for (const row of rows) {
      const item = document.createElement("dl");
      item.className = "metric-item";
      const term = document.createElement("dt");
      term.textContent = row.label;
      const value = document.createElement("dd");
      value.textContent = row.value;
      item.append(term, value);
      if (row.detail) {
        const detail = document.createElement("small");
        detail.textContent = row.detail;
        item.append(detail);
      }
      container.append(item);
    }
  }

  function extractMetricRows(metrics) {
    if (!metrics) {
      return [];
    }

    if (Array.isArray(metrics)) {
      return metrics.map(metricArrayItemToRow).filter(Boolean);
    }

    if (typeof metrics !== "object") {
      return [{ label: "额度", value: formatScalar(metrics) }];
    }

    const rows = [];
    if (Array.isArray(metrics.windows)) {
      for (const windowMetric of metrics.windows) {
        const row = windowToMetricRow(windowMetric);
        if (row) {
          rows.push(row);
        }
      }
    }

    const balanceList = Array.isArray(metrics.balanceInfos)
      ? metrics.balanceInfos
      : Array.isArray(metrics.balance_infos)
        ? metrics.balance_infos
        : [];
    for (const balance of balanceList) {
      if (!balance || typeof balance !== "object") {
        continue;
      }
      const currency = balance.currency || metrics.currency || "";
      const amount = firstDefined(balance.totalBalance, balance.total_balance, balance.balance);
      if (amount !== undefined) {
        rows.push({
          label: currency ? `${currency} 余额` : "账户余额",
          value: formatAmount(amount, currency),
          detail: balance.topped_up_balance !== undefined ? `充值余额 ${formatAmount(balance.topped_up_balance, currency)}` : ""
        });
      }
    }

    const commonKeys = [
      "accountLabel",
      "remainingPercent",
      "usedPercent",
      "remaining",
      "balance",
      "totalBalance",
      "totalCredits",
      "totalUsage",
      "limitRemaining",
      "limit"
    ];
    for (const key of commonKeys) {
      if (metrics[key] !== undefined && !rows.some((row) => row.sourceKey === key)) {
        rows.push(metricObjectEntryToRow(key, metrics[key], metrics));
      }
    }

    if (!rows.length) {
      for (const [key, value] of Object.entries(metrics)) {
        if (rows.length >= 8 || !isSafeMetricValue(key, value)) {
          continue;
        }
        rows.push(metricObjectEntryToRow(key, value, metrics));
      }
    }

    return rows.filter(Boolean);
  }

  function metricArrayItemToRow(item, index) {
    if (item === null || item === undefined) {
      return null;
    }
    if (typeof item !== "object") {
      return { label: `额度 ${index + 1}`, value: formatScalar(item) };
    }
    if (item.kind || item.window) {
      return windowToMetricRow(item);
    }
    const metricTypeLabels = {
      credits: "账户剩余额度",
      spend_limit: "密钥剩余额度",
      balance: "账户余额"
    };
    const label = firstDefined(
      item.label,
      item.name,
      metricTypeLabels[item.metricType],
      item.currency,
      `额度 ${index + 1}`
    );
    const unit = firstDefined(item.unit, item.currency, "");
    const remaining = firstDefined(item.remaining, item.limitRemaining, item.balance, item.totalBalance, item.total_balance);
    const value = remaining !== undefined ? remaining : firstDefined(item.value, item.total);
    if (value === undefined) {
      return null;
    }
    const detailParts = [];
    if (item.value !== undefined && remaining !== undefined) {
      detailParts.push(`已用 ${formatValueWithUnit(item.value, unit)}`);
    }
    if (item.usedPercent !== undefined && item.usedPercent !== null) {
      detailParts.push(`占 ${formatPercent(item.usedPercent)}`);
    }
    if (item.limit !== undefined && item.limit !== null) {
      detailParts.push(`上限 ${formatValueWithUnit(item.limit, unit)}`);
    }
    return {
      label: String(label),
      value: formatValueWithUnit(value, unit),
      detail: item.detail ? String(item.detail) : detailParts.join("；")
    };
  }

  function windowToMetricRow(windowMetric) {
    if (!windowMetric || typeof windowMetric !== "object") {
      return null;
    }
    const kindLabels = {
      session: "当前使用窗口",
      weekly: "每周额度",
      monthly: "每月额度",
      billing: "账户额度",
      daily: "每日额度"
    };
    const kind = String(firstDefined(windowMetric.kind, windowMetric.window, windowMetric.label, "额度"));
    let value;
    if (windowMetric.usedPercent !== undefined) {
      value = `已用 ${formatPercent(windowMetric.usedPercent)}`;
    } else if (windowMetric.remainingPercent !== undefined) {
      value = `剩余 ${formatPercent(windowMetric.remainingPercent)}`;
    } else if (windowMetric.remaining !== undefined) {
      value = formatScalar(windowMetric.remaining);
    } else {
      return null;
    }
    const resetsAt = firstDefined(windowMetric.resetsAt, windowMetric.resetAt, windowMetric.reset_at);
    return {
      label: kindLabels[kind.toLowerCase()] || kind,
      value,
      detail: resetsAt ? `重置于 ${formatDateTime(resetsAt)}` : ""
    };
  }

  function metricObjectEntryToRow(key, value, metrics) {
    const labels = {
      accountLabel: "账户",
      remainingPercent: "剩余比例",
      usedPercent: "已用比例",
      remaining: "剩余额度",
      balance: "账户余额",
      totalBalance: "账户余额",
      totalCredits: "累计额度",
      totalUsage: "累计使用",
      limitRemaining: "密钥剩余额度",
      limit: "密钥额度上限",
      isAvailable: "账户可用",
      currency: "币种"
    };
    let formatted = formatScalar(value);
    if (key.toLowerCase().includes("percent")) {
      formatted = formatPercent(value);
    } else if (["remaining", "balance", "totalBalance", "totalCredits", "totalUsage", "limitRemaining", "limit"].includes(key)) {
      formatted = formatAmount(value, metrics.currency || "");
    }
    return { label: labels[key] || humanizeKey(key), value: formatted, sourceKey: key };
  }

  function isSafeMetricValue(key, value) {
    if (value === null || typeof value === "object") {
      return false;
    }
    if (/token|secret|password|api.?key/i.test(key)) {
      return false;
    }
    return ["string", "number", "boolean"].includes(typeof value);
  }

  function humanizeKey(key) {
    return String(key)
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (character) => character.toUpperCase());
  }

  function formatScalar(value) {
    if (typeof value === "boolean") {
      return value ? "是" : "否";
    }
    if (typeof value === "number") {
      return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
    }
    return String(value);
  }

  function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number)}%`;
  }

  function formatAmount(value, currency) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }
    const amount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(number);
    return currency ? `${amount} ${currency}` : amount;
  }

  function formatValueWithUnit(value, unit) {
    const normalizedUnit = String(unit || "").trim();
    if (normalizedUnit.toLowerCase() === "percent" || normalizedUnit === "%") {
      return formatPercent(value);
    }
    return formatAmount(value, normalizedUnit);
  }

  function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 60) {
      return `${value} 秒`;
    }
    if (value % 3600 === 0) {
      return `${value / 3600} 小时`;
    }
    if (value % 60 === 0) {
      return `${value / 60} 分钟`;
    }
    return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function normalizeTimestamp(value) {
    if (typeof value === "number" && value > 0 && value < 100000000000) {
      return value * 1000;
    }
    return value;
  }

  function formatDateTime(value) {
    const date = new Date(normalizeTimestamp(value));
    if (Number.isNaN(date.getTime())) {
      return "时间未知";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function findLatestUpdate(providers) {
    const timestamps = providers
      .map((provider) => new Date(normalizeTimestamp(provider.updatedAt)).getTime())
      .filter(Number.isFinite);
    if (!timestamps.length) {
      return "尚无数据";
    }
    return formatDateTime(Math.max(...timestamps));
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    const adminPassword = byId("adminToken").value;
    if (adminPassword.length < 12) {
      setFormMessage("authMessage", "管理密码至少需要 12 个字符。", "error");
      byId("adminToken").focus();
      return;
    }

    const button = byId("loginButton");
    setButtonBusy(button, true, "正在连接");
    setFormMessage("authMessage", "", "");
    try {
      const session = await publicApi("/admin/api/session", {
        method: "POST",
        body: { adminPassword }
      });
      if (!session.sessionToken || !storeToken(session.sessionToken)) {
        throw new Error("当前浏览器无法保存管理会话。");
      }
      byId("adminToken").value = "";
      await loadState({ initial: true });
    } catch (error) {
      setFormMessage("authMessage", error.message || "登录失败。", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleSetupSubmit(event) {
    event.preventDefault();
    const adminPassword = byId("setupPassword").value;
    const confirmation = byId("setupPasswordConfirm").value;
    if (adminPassword.length < 12) {
      setFormMessage("setupMessage", "管理密码至少需要 12 个字符。", "error");
      byId("setupPassword").focus();
      return;
    }
    if (adminPassword !== confirmation) {
      setFormMessage("setupMessage", "两次输入的管理密码不一致。", "error");
      byId("setupPasswordConfirm").focus();
      return;
    }
    const button = byId("setupButton");
    setButtonBusy(button, true, "正在保存");
    setFormMessage("setupMessage", "", "");
    try {
      const session = await publicApi("/admin/api/setup", {
        method: "POST",
        body: { adminPassword }
      });
      if (!session.sessionToken || !storeToken(session.sessionToken)) {
        throw new Error("当前浏览器无法保存管理会话。");
      }
      await loadState({ initial: true });
      showGlobalAlert("首次设置完成。请复制手机桥接 Secret，并连接 Codex。", "success", 6000);
    } catch (error) {
      setFormMessage("setupMessage", error.message || "首次设置失败。", "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function logout() {
    await cancelCodexLogin({ quiet: true });
    await api("/admin/api/session", { method: "DELETE" }).catch(() => {});
    clearToken();
    currentState = null;
    showLogin("已退出当前管理会话。", "success");
  }

  async function rotateBridgeSecret() {
    if (!window.confirm("重新生成后，手机里的旧 Secret 会立即失效。继续吗？")) return;
    const button = byId("rotateBridgeSecretButton");
    setButtonBusy(button, true, "生成中");
    try {
      const state = await api("/admin/api/bridge/rotate", { method: "POST" });
      currentState = state;
      renderState(state);
      showGlobalAlert("新的手机桥接 Secret 已生成，请同步更新手机 App。", "success", 5000);
    } catch (error) {
      if (error.isAuthError) {
        clearToken();
        showLogin("管理会话已失效，请重新登录。", "error");
      } else {
        showGlobalAlert(error.message || "Secret 生成失败。", "error");
      }
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();
    const pollIntervalSeconds = Number(byId("pollIntervalSeconds").value);
    const staleAfterSeconds = Number(byId("staleAfterSeconds").value);
    const refreshWindowStart = byId("refreshWindowStart").value;
    const refreshWindowEnd = byId("refreshWindowEnd").value;
    if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 60 || pollIntervalSeconds > 86400) {
      setFormMessage("settingsMessage", "刷新间隔必须是 60 到 86400 秒之间的整数。", "error");
      byId("pollIntervalSeconds").focus();
      return;
    }
    if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 60 || staleAfterSeconds > 604800) {
      setFormMessage("settingsMessage", "过期时间必须是 60 到 604800 秒之间的整数。", "error");
      byId("staleAfterSeconds").focus();
      return;
    }
    if (staleAfterSeconds < pollIntervalSeconds) {
      setFormMessage("settingsMessage", "数据过期时间不能短于刷新间隔。", "error");
      byId("staleAfterSeconds").focus();
      return;
    }
    const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!clockPattern.test(refreshWindowStart) || !clockPattern.test(refreshWindowEnd)) {
      setFormMessage("settingsMessage", "请选择有效的自动刷新开始和结束时间。", "error");
      (!clockPattern.test(refreshWindowStart)
        ? byId("refreshWindowStart")
        : byId("refreshWindowEnd")).focus();
      return;
    }

    const button = byId("saveSettingsButton");
    setButtonBusy(button, true, "正在保存");
    setFormMessage("settingsMessage", "", "");
    try {
      await api("/admin/api/settings", {
        method: "PUT",
        body: {
          pollIntervalSeconds,
          staleAfterSeconds,
          refreshWindowStart,
          refreshWindowEnd
        }
      });
      setFormMessage("settingsMessage", "刷新设置已保存。", "success");
      await loadState();
    } catch (error) {
      handleActionError(error, "settingsMessage");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function saveProvider(id, body, buttonId, messageId) {
    const button = byId(buttonId);
    setButtonBusy(button, true, "正在保存");
    setFormMessage(messageId, "", "");
    try {
      await api(`/admin/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body });
      setFormMessage(messageId, "设置已保存。", "success");
      await loadState();
    } catch (error) {
      handleActionError(error, messageId);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function handleCodexSubmit(event) {
    event.preventDefault();
    return saveProvider(
      "codex",
      { enabled: byId("codexEnabled").checked },
      "codexSaveButton",
      "codexMessage"
    );
  }

  function handleOpenRouterSubmit(event) {
    event.preventDefault();
    const apiKey = byId("openrouterApiKey").value.trim();
    const body = {
      enabled: byId("openrouterEnabled").checked,
      mode: byId("openrouterMode").value
    };
    if (apiKey) {
      body.apiKey = apiKey;
    }
    const operation = saveProvider("openrouter", body, "openrouterSaveButton", "openrouterMessage");
    operation.finally(() => {
      byId("openrouterApiKey").value = "";
    });
    return operation;
  }

  function updateOpenRouterKeyHelp() {
    const creditsMode = byId("openrouterMode").value === "credits";
    byId("openrouterKeyHelp").textContent = creditsMode
      ? "账户余额模式必须使用 OpenRouter Management Key，普通 API Key 无法读取该数据。"
      : "当前密钥限制模式使用需要查询的 OpenRouter API Key。";
  }

  async function clearOpenRouterKey() {
    const confirmed = window.confirm("确定清除 OpenRouter 密钥吗？连接器会同时停用，之后需要重新输入密钥才能启用。");
    if (!confirmed) {
      return;
    }
    const button = byId("openrouterClearKeyButton");
    setButtonBusy(button, true, "正在清除");
    setFormMessage("openrouterMessage", "", "");
    try {
      await api("/admin/api/providers/openrouter", {
        method: "PUT",
        body: { clearApiKey: true, enabled: false }
      });
      byId("openrouterApiKey").value = "";
      setFormMessage("openrouterMessage", "密钥已清除，连接器已停用。", "success");
      await loadState();
    } catch (error) {
      handleActionError(error, "openrouterMessage");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function refreshProvider(id) {
    const button = byId(`${id}RefreshButton`);
    const messageId = `${id}Message`;
    setButtonBusy(button, true, "刷新中");
    setFormMessage(messageId, "正在读取最新额度。", "");
    try {
      const state = await api(`/admin/api/providers/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      currentState = state;
      renderState(state);
      showAppContent();
      const provider = Array.isArray(state.providers)
        ? state.providers.find((item) => item?.id === id)
        : null;
      if (provider?.error || isErrorStatus(provider?.status)) {
        setFormMessage(messageId, provider?.error || "本次刷新没有获得可用额度。", "error");
      } else {
        setFormMessage(messageId, "额度已刷新。", "success");
      }
    } catch (error) {
      handleActionError(error, messageId);
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function refreshAllProviders() {
    const button = byId("refreshAllButton");
    setButtonBusy(button, true, "刷新中");
    try {
      const state = await api("/admin/api/refresh", { method: "POST" });
      currentState = state;
      renderState(state);
      showAppContent();
      const failed = Array.isArray(state.providers)
        ? state.providers.filter((provider) => provider?.enabled && (
          provider.error || isErrorStatus(provider.status)
        ))
        : [];
      if (failed.length > 0) {
        showGlobalAlert(`${failed.length} 个连接器刷新失败，Hub 将按计划重试。`, "error", 5000);
      } else {
        showGlobalAlert("所有已启用连接器均已刷新。", "success", 3000);
      }
    } catch (error) {
      if (error.isAuthError) {
        clearToken();
        showLogin("管理会话已失效，请重新登录。", "error");
      } else {
        showGlobalAlert(error.message || "刷新失败，请稍后重试。", "error");
      }
    } finally {
      setButtonBusy(button, false);
    }
  }

  function handleActionError(error, messageId) {
    if (error.isAuthError) {
      clearToken();
      showLogin("管理会话已失效，请重新登录。", "error");
      return;
    }
    setFormMessage(messageId, error.message || "操作失败，请稍后重试。", "error");
  }

  async function startCodexLogin() {
    const dialog = byId("codexLoginDialog");
    if (!dialog.open) {
      dialog.showModal();
    }
    resetCodexLoginView();
    const generation = ++codexLoginGeneration;
    const attemptId = createCodexLoginId();
    codexLoginId = attemptId;
    codexLoginActive = true;
    codexLoginStartedAt = Date.now();
    byId("codexConnectButton").disabled = true;

    try {
      const login = await api("/admin/api/providers/codex/login", {
        method: "POST",
        headers: { "X-VWatch-Login-Id": attemptId }
      });
      if (generation !== codexLoginGeneration) return;
      codexLoginId = typeof login.id === "string" && login.id ? login.id : attemptId;
      renderCodexLogin(login, generation);
      if (codexLoginActive && generation === codexLoginGeneration) {
        scheduleCodexLoginPoll(generation);
      }
    } catch (error) {
      if (generation !== codexLoginGeneration) return;
      await cancelCodexLogin({ closeDialog: false, quiet: true });
      byId("codexConnectButton").disabled = false;
      byId("codexLoginProgress").hidden = true;
      byId("codexLoginMessage").textContent = error.message || "无法开始 Codex 登录。";
      byId("codexLoginMessage").className = "dialog-message is-error";
    }
  }

  function createCodexLoginId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `vqh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function resetCodexLoginView() {
    stopCodexLoginPolling(false);
    byId("codexLoginProgress").hidden = false;
    byId("codexLoginProgress").lastElementChild.textContent = "正在申请设备码";
    byId("codexDeviceCode").hidden = true;
    byId("codexLoginMessage").textContent = "";
    byId("codexLoginMessage").className = "dialog-message";
    byId("codexUserCode").textContent = "等待中";
    byId("codexVerificationLink").href = "#";
    byId("codexLoginExpiry").textContent = "";
  }

  function scheduleCodexLoginPoll(generation) {
    window.clearTimeout(codexLoginTimer);
    codexLoginTimer = window.setTimeout(() => pollCodexLogin(generation), 2000);
  }

  async function pollCodexLogin(generation) {
    if (!codexLoginActive || generation !== codexLoginGeneration) {
      return;
    }
    if (Date.now() - codexLoginStartedAt > 10 * 60 * 1000) {
      await cancelCodexLogin({ closeDialog: false, quiet: true });
      finishCodexLogin("设备码登录已超时，请重新开始。", "error");
      return;
    }
    try {
      const login = await api("/admin/api/providers/codex/login");
      if (generation !== codexLoginGeneration) return;
      renderCodexLogin(login, generation);
      if (codexLoginActive && generation === codexLoginGeneration) {
        scheduleCodexLoginPoll(generation);
      }
    } catch (error) {
      if (generation !== codexLoginGeneration) return;
      if (error.isAuthError) {
        stopCodexLoginPolling();
        clearToken();
        if (byId("codexLoginDialog").open) {
          byId("codexLoginDialog").close();
        }
        showLogin("管理会话已失效，请重新登录。", "error");
        return;
      }
      await cancelCodexLogin({ closeDialog: false, quiet: true });
      finishCodexLogin(error.message || "无法读取登录进度。", "error");
    }
  }

  function renderCodexLogin(rawLogin, generation) {
    if (generation !== codexLoginGeneration) return;
    const login = rawLogin && typeof rawLogin.login === "object" ? rawLogin.login : rawLogin || {};
    const status = String(login.status || login.phase || "pending").toLowerCase();
    const successStates = ["success", "complete", "completed", "connected", "authenticated", "done"];
    const errorStates = ["error", "failed", "expired", "cancelled", "canceled"];

    if (successStates.includes(status)) {
      finishCodexLogin("Codex 账号已连接。", "success");
      void followCodexRefresh(generation);
      return;
    }
    if (errorStates.includes(status)) {
      finishCodexLogin(login.error || login.message || "Codex 登录未完成，请重试。", "error");
      return;
    }

    const code = firstDefined(login.userCode, login.user_code, login.code);
    const verificationUrl = firstDefined(
      login.verificationUrl,
      login.verificationUri,
      login.verification_url,
      login.verification_uri,
      login.url
    );
    if (code) {
      byId("codexUserCode").textContent = String(code);
      byId("codexDeviceCode").hidden = false;
    }
    if (verificationUrl && isSafeHttpUrl(verificationUrl)) {
      byId("codexVerificationLink").href = String(verificationUrl);
      byId("codexVerificationLink").hidden = false;
    } else {
      byId("codexVerificationLink").hidden = true;
    }

    const expiresAt = firstDefined(login.expiresAt, login.expires_at);
    const expiresIn = firstDefined(login.expiresIn, login.expires_in);
    if (expiresAt) {
      byId("codexLoginExpiry").textContent = `设备码有效至 ${formatDateTime(expiresAt)}`;
    } else if (expiresIn) {
      byId("codexLoginExpiry").textContent = `设备码约 ${formatDuration(Number(expiresIn))} 后过期`;
    }

    byId("codexLoginProgress").hidden = false;
    byId("codexLoginProgress").lastElementChild.textContent = code ? "等待你完成登录" : "正在准备登录信息";
    byId("codexLoginMessage").textContent = login.message && typeof login.message === "string" ? login.message : "";
  }

  async function followCodexRefresh(generation) {
    const deadline = Date.now() + 60_000;
    while (generation === codexLoginGeneration && Date.now() < deadline) {
      const state = await loadState();
      if (!state || generation !== codexLoginGeneration) return;
      const codex = Array.isArray(state.providers)
        ? state.providers.find((provider) => provider && provider.id === "codex")
        : null;
      if (!codex || !["idle", "refreshing"].includes(String(codex.status || "").toLowerCase())) {
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
    if (generation === codexLoginGeneration) {
      showGlobalAlert("Codex 已登录，额度仍在后台刷新。", "success", 4000);
    }
  }

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  function finishCodexLogin(message, type) {
    stopCodexLoginPolling();
    byId("codexLoginProgress").hidden = true;
    if (type === "success") byId("codexDeviceCode").hidden = true;
    byId("codexLoginMessage").textContent = message;
    byId("codexLoginMessage").className = `dialog-message is-${type}`;
    byId("codexConnectButton").disabled = false;
  }

  function stopCodexLoginPolling(resetActive = true) {
    window.clearTimeout(codexLoginTimer);
    codexLoginTimer = null;
    if (resetActive) {
      codexLoginActive = false;
    }
  }

  async function cancelCodexLogin({ closeDialog = true, quiet = false } = {}) {
    const shouldCancel = codexLoginActive;
    const loginId = codexLoginId;
    codexLoginGeneration += 1;
    codexLoginId = null;
    stopCodexLoginPolling();
    if (closeDialog && byId("codexLoginDialog").open) {
      byId("codexLoginDialog").close();
    }
    if (!shouldCancel || !loginId) {
      byId("codexConnectButton").disabled = false;
      return;
    }
    try {
      await api(`/admin/api/providers/codex/login?id=${encodeURIComponent(loginId)}`, {
        method: "DELETE"
      });
    } catch (error) {
      if (!quiet && !error.isAuthError) {
        showGlobalAlert("Codex 登录进程可能仍在运行，请稍后重试。", "error");
      }
    } finally {
      byId("codexConnectButton").disabled = false;
    }
  }

  function cancelCodexLoginOnPageHide() {
    if (!codexLoginActive) return;
    const token = getStoredToken();
    const loginId = codexLoginId;
    codexLoginGeneration += 1;
    codexLoginId = null;
    stopCodexLoginPolling();
    if (!token || !loginId) return;
    void fetch(`/admin/api/providers/codex/login?id=${encodeURIComponent(loginId)}`, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Requested-With": "VWatch-Quota-Hub"
      },
      cache: "no-store",
      credentials: "same-origin",
      keepalive: true
    }).catch(() => {});
  }

  async function writeClipboard(text, successMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const temporary = document.createElement("textarea");
        temporary.value = text;
        temporary.setAttribute("readonly", "");
        temporary.className = "clipboard-proxy";
        document.body.append(temporary);
        temporary.select();
        const copied = document.execCommand("copy");
        temporary.remove();
        if (!copied) {
          throw new Error("copy failed");
        }
      }
      showToast(successMessage);
    } catch {
      showToast("复制失败，请手动选择内容。");
    }
  }

  function bindEvents() {
    byId("setupForm").addEventListener("submit", handleSetupSubmit);
    byId("loginForm").addEventListener("submit", handleLoginSubmit);
    byId("logoutButton").addEventListener("click", logout);
    byId("themeButton").addEventListener("click", cycleTheme);
    byId("retryButton").addEventListener("click", () => loadState({ initial: true }));
    byId("refreshAllButton").addEventListener("click", refreshAllProviders);
    byId("settingsForm").addEventListener("submit", handleSettingsSubmit);
    byId("codexForm").addEventListener("submit", handleCodexSubmit);
    byId("openrouterForm").addEventListener("submit", handleOpenRouterSubmit);
    byId("openrouterMode").addEventListener("change", updateOpenRouterKeyHelp);
    byId("openrouterClearKeyButton").addEventListener("click", clearOpenRouterKey);
    byId("codexRefreshButton").addEventListener("click", () => refreshProvider("codex"));
    byId("openrouterRefreshButton").addEventListener("click", () => refreshProvider("openrouter"));
    byId("codexConnectButton").addEventListener("click", startCodexLogin);
    byId("closeCodexDialogButton").addEventListener("click", () => {
      void cancelCodexLogin();
    });
    byId("codexLoginDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      void cancelCodexLogin();
    });
    window.addEventListener("pagehide", cancelCodexLoginOnPageHide);
    byId("copyCodeButton").addEventListener("click", () => {
      writeClipboard(byId("codexUserCode").textContent, "设备码已复制。");
    });
    byId("copyEndpointButton").addEventListener("click", () => {
      writeClipboard(byId("bridgeEndpoint").dataset.copyValue || byId("bridgeEndpoint").textContent, "额度地址已复制。");
    });
    byId("copyBridgeSecretButton").addEventListener("click", () => {
      writeClipboard(byId("bridgeSecret").dataset.copyValue || "", "手机桥接 Secret 已复制。");
    });
    byId("rotateBridgeSecretButton").addEventListener("click", rotateBridgeSecret);

    document.querySelectorAll(".nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("is-active"));
        link.classList.add("is-active");
      });
    });
  }

  async function initialize() {
    applyTheme(getStoredTheme());
    bindEvents();
    try {
      const setup = await publicApi("/admin/api/setup");
      if (setup.setupRequired) {
        clearToken();
        showSetup();
        return;
      }
      if (getStoredToken()) {
        await loadState({ initial: true });
      } else {
        showLogin("", "");
      }
    } catch (error) {
      showLogin(error.message || "无法读取 Hub 初始化状态。", "error");
    }
  }

  void initialize();
})();

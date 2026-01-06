import axios from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import config from '../config/config.js';

// ==================== DNS & 代理统一配置 ====================

// 自定义 DNS 解析：优先 IPv4，失败则回退 IPv6
function customLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, family: 4 }, (err4, address4, family4) => {
    if (!err4 && address4) {
      return callback(null, address4, family4);
    }
    dns.lookup(hostname, { ...options, family: 6 }, (err6, address6, family6) => {
      if (!err6 && address6) {
        return callback(null, address6, family6);
      }
      callback(err4 || err6);
    });
  });
}

// 使用自定义 DNS 解析的 Agent（优先 IPv4，失败则 IPv6）
const httpAgent = new http.Agent({
  lookup: customLookup,
  keepAlive: true
});

const httpsAgent = new https.Agent({
  lookup: customLookup,
  keepAlive: true
});

// 统一构建代理配置
function buildProxyConfig() {
  if (!config.proxy) return false;
  try {
    const proxyUrl = new URL(config.proxy);
    return {
      protocol: proxyUrl.protocol.replace(':', ''),
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port, 10)
    };
  } catch {
    return false;
  }
}

// 为 axios 构建统一请求配置
export function buildAxiosRequestConfig({
  method = 'POST',
  url,
  headers,
  data = null,
  timeout = config.timeout,
  responseType
}) {
  const axiosConfig = {
    method,
    url,
    headers,
    timeout,
    httpAgent,
    httpsAgent,
    proxy: buildProxyConfig()
  };

  if (responseType) axiosConfig.responseType = responseType;
  if (data !== null) axiosConfig.data = data;
  return axiosConfig;
}

// 简单封装 axios 调用，方便后续统一扩展（重试、打点等）
export async function httpRequest(configOverrides) {
  const axiosConfig = buildAxiosRequestConfig(configOverrides);
  return axios(axiosConfig);
}

// 流式请求封装
export async function httpStreamRequest(configOverrides) {
  const axiosConfig = buildAxiosRequestConfig(configOverrides);
  axiosConfig.responseType = 'stream';
  return axios(axiosConfig);
}

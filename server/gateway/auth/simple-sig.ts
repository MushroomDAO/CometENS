/**
 * 简单签名认证模块
 * 
 * 安全模型:
 * - 客户端用私钥签名固定格式消息
 * - 服务端验证签名来自该地址且消息格式正确
 * - 可选: 地址白名单
 * 
 * 环境变量:
 *   REGISTRATION_SECRET - 签名用的密钥（只存服务端）
 *   ALLOWED_REGISTRANTS - 可选白名单（逗号分隔地址）
 */

import { recoverMessageAddress, type Address, type Hex } from 'viem'

export interface SignatureAuthPayload {
  address: Address      // 声称的地址
  timestamp: number     // 时间戳（防重放）
  signature: Hex        // 签名
}

// 从环境变量读取配置
const SECRET = process.env.REGISTRATION_SECRET || ''
const ALLOWED_LIST = (process.env.ALLOWED_REGISTRANTS || '')
  .split(',')
  .filter(Boolean)
  .map(a => a.toLowerCase())

// 时间窗口（秒）
const TIME_WINDOW = 300 // 5分钟

/**
 * 构建待签名消息
 */
export function buildAuthMessage(secret: string, timestamp: number): string {
  return `cometens:auth:${secret}:${timestamp}`
}

/**
 * 验证签名认证
 * 
 * @param payload 客户端提交的认证数据
 * @returns {Promise<{valid: boolean; error?: string}>}
 */
export async function verifySignatureAuth(
  payload: SignatureAuthPayload
): Promise<{ valid: boolean; error?: string }> {
  const { address, timestamp, signature } = payload

  // 1. 检查配置
  if (!SECRET) {
    return { valid: false, error: 'Server authentication not configured' }
  }

  // 2. 验证时间戳（防重放攻击）
  const now = Math.floor(Date.now() / 1000)
  const drift = Math.abs(now - timestamp)
  if (drift > TIME_WINDOW) {
    return { valid: false, error: `Timestamp expired (drift: ${drift}s)` }
  }

  // 3. 构建期望的消息
  const message = buildAuthMessage(SECRET, timestamp)

  // 4. 恢复签名地址
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message, signature })
  } catch (e) {
    return { valid: false, error: 'Invalid signature format' }
  }

  // 5. 验证地址匹配
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { 
      valid: false, 
      error: `Signature mismatch: recovered ${recovered}, claimed ${address}` 
    }
  }

  // 6. 验证白名单（如果配置了）
  if (ALLOWED_LIST.length > 0) {
    if (!ALLOWED_LIST.includes(address.toLowerCase())) {
      return { valid: false, error: 'Address not in allowed list' }
    }
  }

  return { valid: true }
}

/**
 * 快速检查：地址是否在白名单
 */
export function isAddressAllowed(address: Address): boolean {
  if (ALLOWED_LIST.length === 0) return true
  return ALLOWED_LIST.includes(address.toLowerCase())
}

/**
 * 获取允许的注册者列表（用于调试）
 */
export function getAllowedRegistrants(): string[] {
  return ALLOWED_LIST
}

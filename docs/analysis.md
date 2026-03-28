  ENS V2 深度分析 + CometENS 开发部署计划      
                                                                                                                                                      
  ---                                                                                                                                                
  一、ENS V2 vs V1：核心变化                                                                                                                          
                                                                                                                                                      
  1.1 最根本的架构转变：从"全局单一注册表"到"每名自有注册表"
                                                                                                                                                      
  ┌────────────┬────────────────────────────────┬───────────────────────────────────────┐                                                             
  │    维度    │           V1（当前）           │               V2（新）                │                                                             
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤                                                             
  │ 注册表结构 │ 一个全局 Registry 管所有名字   │ 每个 .eth 名字拥有自己独立的 Registry │                                                            
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤
  │ 部署层     │ 全部在 Ethereum L1             │ .eth 注册/续费全部迁移到 L2           │                                                             
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤                                                             
  │ Gas 成本   │ 注册/续费昂贵（L1 Gas）        │ L2 极低 Gas，注册更便宜               │                                                             
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤                                                             
  │ 子域名控制 │ 通过 Name Wrapper + Fuses 实现 │ 每名自有 Registry，控制更直接、更灵活 │                                                            
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤                                                             
  │ 跨链解析   │ 依赖 CCIP-Read（已有）         │ 原生多链支持，L2 是一等公民           │                                                            
  ├────────────┼────────────────────────────────┼───────────────────────────────────────┤                                                             
  │ Resolver   │ 独立部署，V1 Public Resolver   │ 新 Resolver 规范，与 L2 深度集成      │                                                            
  └────────────┴────────────────────────────────┴───────────────────────────────────────┘                                                             
                                                                                                                                                     
  1.2 V2 的新能力                                                                                                                                     
                                                                                                                                                     
  ① 每名自有 Registry（Per-name Registry）                                                                                                            
  - V1：所有 .eth 名字都住在同一个全局 Registry 合约里
  - V2：alice.eth 有自己的 Registry，bob.eth 有自己的 Registry                                                                                        
  - 意义：子域名管理权完全归名字所有者，无需 Name Wrapper 的 Fuse 机制                                                                               
                                                                                                                                                      
  ② L2 是注册层（不只是存储层）                                                                                                                       
  - V2 把 .eth 的注册、续费逻辑直接部署到 L2                                                                                                          
  - L1 主网保留所有权锚定，但日常操作在 L2 完成                                                                                                       
  - 这与当前 CometENS 的 L2Records 方案方向一致，但更彻底                                                                                             
                                                                                                                                                      
  ③ 信任最小化的跨链解析                                                                                                                              
  - 在 V2 中，CCIP-Read + EVM Gateway（状态证明）成为标准路径                                                                                         
  - 不再依赖可信签名（OffchainResolver），而是用 Merkle/Bedrock 状态证明验证 L2 数据真实性                                                            
  - 对应现有架构的"里程碑 C：OPResolver"                                                                                                             
                                                                                                                                                      
  ④ 向上兼容                                                                                                                                          
  - 现有的 .eth 名字可以迁移（upgrade tool 在开发中）                                                                                                 
  - 迁移后，旧解析方式仍然可用                                                                                                                        
                                                                                                                                                      
  1.3 对你当前架构的意义                                                                                                                              
                                                                                                                                                      
  你现有的 CometENS 设计文档的路径与 ENS V2 方向高度一致：                                                                                            
                                                                                                                                                      
  你的架构                    ENS V2 对应                                                                                                             
  L2Records MVP          →   L2 存储（先行验证）                                                                                                      
  OffchainResolver       →   V2 的可信签名解析（过渡态）                                                                                              
  OPResolver（里程碑C）  →   V2 标准：状态证明解析（最终形态）                                                                                        
  Name Wrapper on L2     →   V2 的 Per-name Registry 替代方案                                                                                         
                                                                                                                                                      
  ---                                                                                                                                                 
  二、结合当前代码库的解决方案                                                                                                                        
                                                                                                                                                      
  2.1 现状盘点                                 
                                                                                                                                                      
  当前代码库已完成的部分：                                                                                                                            
  - server/gateway/index.ts — CCIP-Read 网关框架（签名模式）
  - server/gateway/readers/L2RecordsReader.ts — L2 合约读取器                                                                                         
  - server/gateway/manage/schemas.ts — EIP-712 Register/SetAddr 类型                                                                                 
  - src/eth.ts — L1/L2 双模式查询 + EIP-712 签名 UI                 
  - vite.config.ts — 内嵌开发网关（POST /api/ccip + /api/manage）                                                                                     
                                                                                                                                                      
  缺失/待完成的部分：                                                                                                                                 
  1. L2Records 合约本身（尚未部署）                                                                                                                   
  2. L1 OffchainResolver 合约（尚未部署）                                                                                                             
  3. 注册子域名的写路径（/api/manage 只验签，不执行 L2 写入）                                                                                         
  4. Admin Portal 前端（注册/查询/管理 UI）                                                                                                           
  5. Worker EOA（代理执行 L2 交易的服务账号）                                                                                                         
                                                                                                                                                      
  2.2 推荐方案：两阶段                                                                                                                                
                                                                                                                                                      
  阶段一：签名验证 MVP（对应里程碑 A）                                                                                                                
                                                                                                                                                      
  用可信签名模式跑通完整闭环，最快路径验证产品。                                                                                                      
                                                                                                                                                     
  L1 OffchainResolver ──CCIP-Read──→ Gateway                                                                                                          
                                        │                                                                                                             
                                     读 L2Records
                                        │                                                                                                             
                                     签名返回                                                                                                        
                                        │                                                                                                             
  L1 OffchainResolver ←── 验签 ─────────┘
                                                                                                                                                      
  阶段二：状态证明（对应里程碑 C，ENS V2 标准路径）                                                                                                   
                                                                                                                                                      
  用 OPResolver 替换签名验证，实现信任最小化。                                                                                                        
                                                                                                                                                     
  ---                                                                                                                                                 
  三、开发与部署计划                                                                                                                                 
                                               
  里程碑 A：可信签名 MVP（当前阶段，约 2-3 周）
                                                                                                                                                      
  A1 — 部署 L2Records 合约（OP Sepolia）                                                                                                              
                                                                                                                                                      
  需要编写并部署的合约 L2Records.sol：                                                                                                                
                                                                                                                                                     
  // 极简版，存储 node → coinType → addr 映射                                                                                                         
  mapping(bytes32 => mapping(uint256 => bytes)) public addrs;                                                                                        
  mapping(bytes32 => mapping(string => string)) public texts;
  mapping(bytes32 => bytes) public contenthashes;
                                                                                                                                                      
  function setAddr(bytes32 node, uint256 coinType, bytes calldata addr) external onlyOwner { ... }
  function setSubnodeOwner(bytes32 parentNode, bytes32 labelhash, address owner) external onlyOwner { ... }                                           
                                                                                                                                                     
  工具：Hardhat 或 Foundry，部署到 OP Sepolia，地址填入 .env。

  A2 — 完善 Gateway 写路径                                                                                                                            
   
  当前 vite.config.ts 的 /api/manage 只做了签名验证，缺少 L2 写入。需补充：                                                                           
                                                                                                                                                     
  POST /api/manage/register                                                                                                                           
    1. 验证 EIP-712 签名 ✅（已有）                                                                                                                  
    2. 检查 nonce/deadline ✅（已有）                                                                                                                 
    3. NEW: Worker EOA 调用 L2Records.setSubnodeOwner()                                                                                               
    4. NEW: 返回 txHash                                                                                                                               
                                                                                                                                                      
  POST /api/manage/set-addr                                                                                                                           
    1. 验证 EIP-712 签名 ✅（已有）                                                                                                                  
    2. NEW: Worker EOA 调用 L2Records.setAddr()                                                                                                       
    3. NEW: 返回 txHash
                                                                                                                                                      
  需要在环境变量中添加 WORKER_EOA_PRIVATE_KEY（独立于 PRIVATE_KEY_SUPPLIER）。                                                                        
                                                                                                                                                      
  A3 — 部署 L1 OffchainResolver（Sepolia）                                                                                                            
                                                                                                                                                     
  参考 https://github.com/ensdomains/offchain-resolver 模板，核心是：                                                                                 
                                                                                                                                                     
  // OffchainResolver.sol 关键逻辑                                                                                                                    
  function resolve(bytes calldata name, bytes calldata data)                                                                                         
      external view override returns (bytes memory) {                                                                                                 
      revert OffchainLookup(                                                                                                                          
          address(this),                                                                                                                              
          urls,          // 指向你的 Gateway URL                                                                                                      
          abi.encode(name, data),                                                                                                                    
          this.resolveWithProof.selector,      
          abi.encode(name, data)
      );                                                                                                                                              
  }
                                                                                                                                                      
  function resolveWithProof(bytes calldata response, bytes calldata extraData)                                                                       
      external view returns (bytes memory) {   
      // 验签：签名者必须是 PRIVATE_KEY_SUPPLIER 对应地址
      (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(...);
      require(signer == signerAddress, "bad sig");
      return result;
  }

  部署后，在 Sepolia ENS 上将 yourname.eth 的 resolver 设置为此合约地址。

  A4 — Admin Portal 最小 UI

  基于现有 eth.html / src/eth.ts 扩展，新增：
  - 注册子域名表单（parent / label / owner）→ EIP-712 签名 → POST /api/manage/register
  - 查询子域名列表
  - 设置地址记录表单 → EIP-712 签名 → POST /api/manage/set-addr

  A5 — 端到端验证

  # 测试流程
  1. 在 Sepolia ENS 上查询 alice.yourname.eth 的 addr
  2. 应触发 CCIP-Read → 调用你的 Gateway
  3. Gateway 读 OP Sepolia L2Records → 签名返回
  4. Sepolia 上的 OffchainResolver 验签通过
  5. 返回地址                                                                                                                                         
   
  ---                                                                                                                                                 
  里程碑 B：Name Wrapper + NFT 子域（V2 对齐，约 3-4 周）                                                                                            
                                                                                                                                                      
  切换存储层：L2Records → OP 上的官方 ENS Name Wrapper + Public Resolver
                                                                                                                                                      
  - 子域名成为真正的 ERC-1155 NFT                                                                                                                     
  - 支持 Fuse 机制（冻结解析器、转让限制等）                                                                                                          
  - Gateway 的 Reader 层从 L2RecordsReader 扩展为 NameWrapperReader                                                                                   
                                                                                                                                                      
  ---                                                                                                                                                 
  里程碑 C：状态证明（ENS V2 标准，约 4-6 周）                                                                                                        
                                                                                                                                                      
  部署 OPResolver 替换 OffchainResolver：      
                                                                                                                                                      
  签名模式（当前）：Gateway 签名 → L1 验签                                                                                                            
                     可信依赖：Gateway 签名密钥                                                                                                       
                                                                                                                                                      
  证明模式（V2）：Gateway 返回 Bedrock 状态证明 → L1 验证 Merkle Proof                                                                                
                     无需信任 Gateway，链上可验                                                                                                       
                                                                                                                                                      
  参考：https://github.com/ensdomains/evmgateway（ENS 官方实现，处理了全部 OP Bedrock 证明逻辑）                                                      
                                                                                                                                                      
  ---                                                                                                                                                 
  里程碑 D：生产加固                                                                                                                                 
                                               
  - L1 包裹根域名，烧断 CANNOT_SET_RESOLVER Fuse（不可逆，需谨慎）
  - Worker EOA 密钥轮换方案                                                                                                                           
  - Rate limiting、nonce 防重放
  - 告警与应急预案                                                                                                                                    
                                                                                                                                                     
  ---                                                                                                                                                 
  四、当前代码需要做的最小改动清单                                                                                                                   
                                                                                                                                                      
  ┌────────┬─────────────────────────┬─────────────────────────────────────────────────────────────┐
  │ 优先级 │          文件           │                            改动                             │                                                  
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤                                                 
  │ P0     │ server/gateway/index.ts │ 补充 Worker EOA 写 L2 的调用逻辑                            │
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤
  │ P0     │ vite.config.ts          │ /api/manage 路由拆分为 /register 和 /set-addr，补充 L2 写入 │                                                  
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤
  │ P0     │ .env.op-sepolia         │ 新增 WORKER_EOA_PRIVATE_KEY、L1_OFFCHAIN_RESOLVER_ADDRESS   │                                                  
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤                                                  
  │ P1     │ src/eth.ts              │ 注册子域名的前端流程（签名 + 提交）                         │
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤                                                  
  │ P1     │ 新建 contracts/         │ L2Records.sol + OffchainResolver.sol                        │                                                 
  ├────────┼─────────────────────────┼─────────────────────────────────────────────────────────────┤                                                  
  │ P2     │ src/main.ts             │ Admin Portal 子域名管理 UI                                  │                                                 
  └────────┴─────────────────────────┴─────────────────────────────────────────────────────────────┘                                                  
                                                                                                                                                     
  ---                                          
  五、总结
                                                                                                                                                      
  ENS V2 的核心变化就三句话：
  1. 每名自有 Registry（去中心化控制权）                                                                                                              
  2. L2 是主战场（注册/续费/存储都在 L2，L1 只锚定所有权）                                                                                            
  3. 状态证明替代可信签名（信任最小化，无需依赖 Gateway 诚实）
                                                                                                                                                      
  你的 CometENS 架构路径与 V2 完全对齐。当前最重要的一步是：补全 Gateway 的写路径（Worker EOA →                                                       
  L2），让注册子域名真正能执行，其余都是在已有框架上叠加。

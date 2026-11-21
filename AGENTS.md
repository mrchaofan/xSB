# xSB 开发约束

修改任务、消息、队列、抢占、停止、后台 job 或上下文恢复时，先阅读：

- [turn 生命周期契约](docs/TURN-LIFECYCLE.md)
- [任务图与共享依赖](docs/TASK-GRAPH.md)
- [上下文生命周期设计与实现](docs/context-lifecycle-design.md)

保持一个 Agent 至多一个有效执行 turn；用户输入接收即保护当前 turn。抢占必须在提交点同时校验目标 ID、保护和完整停止权限，无权整体停止时排队，不能部分取消。

显式追加绑定目标 turn，失效不转为待办。用户停止清理旧待办；非用户停止按顺序恢复普通未读输入，抢占者优先。以 ACP 插入回执定义输入消费，隔离旧 turn/后端回执与工具权限。

停止遍历真实 parents 起因边并穿过已结束节点；保留无关活任务仍需要的共享后代。停止提交后不能挂接新 task/job；after 次序依赖不能替代取消边。

同步维护 `packages/hub/src/prompts.ts` 中注入运行模型的 `TASK_LIFECYCLE_RULES`。用 `turns.test.ts`、`stop.test.ts`、`kernel.test.ts` 和 ACP 端到端测试验证相关不变量；文档和提示词不能替代运行时校验。

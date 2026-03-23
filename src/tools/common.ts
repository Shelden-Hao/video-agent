import "dotenv/config";
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi";

// 懒初始化：首次调用时创建，避免模块加载时 dotenv 尚未读取 .env 文件
let _llm: ChatAlibabaTongyi | null = null;
export function getLLM(): ChatAlibabaTongyi {
  if (!_llm) {
    _llm = new ChatAlibabaTongyi({
      alibabaApiKey: process.env.ALIBABA_API_KEY,
      temperature: 0.2,
    });
  }
  return _llm;
}

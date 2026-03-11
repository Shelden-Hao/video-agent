import { PageContainer, ProCard, StepsForm } from '@ant-design/pro-components';
import { Button, Result, Typography } from 'antd';
import React, { useState } from 'react';

const { Paragraph, Text } = Typography;

const steps = ['Topic', 'Script', 'Images', 'Voice', 'Video'] as const;

const WorkflowPage: React.FC = () => {
  const [topic, setTopic] = useState<string>('');

  return (
    <PageContainer
      header={{
        title: 'AI Video Agent Workflow',
        breadcrumb: {},
      }}
    >
      <ProCard>
        <StepsForm
          onFinish={async () => {
            // 这里只做占位：后续接上后端 /api 调用。
            return true;
          }}
        >
          <StepsForm.StepForm
            name="topic"
            title="Topic"
            onFinish={async (values) => {
              setTopic(values.topic);
              return true;
            }}
          >
            <Paragraph>输入你想生成的短视频主题，比如「熊猫」「旅行 Vlog」等。</Paragraph>
            {/* 这里先直接用原生 input，保持简单，后续可换 ProForm 组件 */}
            <input
              style={{ width: '100%', padding: 8, marginTop: 8 }}
              defaultValue={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </StepsForm.StepForm>

          <StepsForm.StepForm name="script" title="Script">
            <Paragraph>此步骤将由 Script Agent 根据 topic 生成脚本。</Paragraph>
          </StepsForm.StepForm>

          <StepsForm.StepForm name="images" title="Images">
            <Paragraph>此步骤将由 Image Agent 调用图片生成工具生成素材。</Paragraph>
          </StepsForm.StepForm>

          <StepsForm.StepForm name="voice" title="Voice">
            <Paragraph>此步骤将由 Voice Agent 生成旁白音频。</Paragraph>
          </StepsForm.StepForm>

          <StepsForm.StepForm name="video" title="Video">
            <Result
              status="info"
              title="Workflow 骨架已就绪"
              subTitle="后续可以在这里展示合成的视频链接 / 预览。"
              extra={
                <Button type="primary">
                  完成
                </Button>
              }
            >
              <Paragraph>
                当前主题：<Text strong>{topic}</Text>
              </Paragraph>
              <Paragraph>
                未来将按照以下顺序自动执行：
                <Text code>{steps.join(' → ')}</Text>
              </Paragraph>
            </Result>
          </StepsForm.StepForm>
        </StepsForm>
      </ProCard>
    </PageContainer>
  );
};

export default WorkflowPage;


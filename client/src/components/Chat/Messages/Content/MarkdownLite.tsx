import { memo, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import { code, codeNoExecution, a, p, img, table } from './MarkdownComponents';
import { CodeBlockProvider, ArtifactProvider } from '~/Providers';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import { langSubset } from '~/utils';
import { maskPrivateLocalPaths } from '~/utils/privatePathMask';

const MarkdownLite = memo(
  ({ content = '', codeExecution = true }: { content?: string; codeExecution?: boolean }) => {
    const privateContent = useMemo(() => maskPrivateLocalPaths(content), [content]);
    const rehypePlugins: PluggableList = [
      [rehypeKatex],
      [
        rehypeHighlight,
        {
          detect: true,
          ignoreMissing: true,
          subset: langSubset,
        },
      ],
    ];

    return (
      <MarkdownErrorBoundary content={privateContent} codeExecution={codeExecution}>
        <ArtifactProvider>
          <CodeBlockProvider>
            <ReactMarkdown
              remarkPlugins={[
                /** @ts-ignore */
                supersub,
                remarkGfm,
                [remarkMath, { singleDollarTextMath: false }],
              ]}
              /** @ts-ignore */
              rehypePlugins={rehypePlugins}
              components={
                {
                  code: codeExecution ? code : codeNoExecution,
                  a,
                  p,
                  img,
                  table,
                } as {
                  [nodeType: string]: React.ElementType;
                }
              }
            >
              {privateContent}
            </ReactMarkdown>
          </CodeBlockProvider>
        </ArtifactProvider>
      </MarkdownErrorBoundary>
    );
  },
);

export default MarkdownLite;

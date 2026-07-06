import React, { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from './markdownConfig';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import MarkdownBlocks from './MarkdownBlocks';
import { preprocessLaTeX } from '~/utils';
import { maskPrivateLocalPaths } from '~/utils/privatePathMask';
import store from '~/store';

type TContentProps = {
  content: string;
  isLatestMessage: boolean;
};

const Markdown = memo(function Markdown({ content = '', isLatestMessage }: TContentProps) {
  const LaTeXParsing = useRecoilValue<boolean>(store.LaTeXParsing);
  const privateContent = useMemo(() => maskPrivateLocalPaths(content), [content]);
  const isInitializing = privateContent === '';

  const currentContent = useMemo(() => {
    if (isInitializing) {
      return '';
    }
    return LaTeXParsing ? preprocessLaTeX(privateContent) : privateContent;
  }, [privateContent, LaTeXParsing, isInitializing]);

  if (isInitializing) {
    return (
      <div className="absolute">
        <p className="relative">
          <span className={isLatestMessage ? 'result-thinking' : ''} />
        </p>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary content={privateContent} codeExecution={true}>
      <MarkdownBlocks
        content={currentContent}
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;

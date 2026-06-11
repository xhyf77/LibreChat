import { QueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, type TMessage } from 'librechat-data-provider';
import {
  cleanupAbortedResumableConversation,
  removeAbortPlaceholderMessages,
} from '../abortCleanup';

jest.mock('~/data-provider', () => ({
  streamStatusQueryKey: (conversationId: string) => ['streamStatus', conversationId],
}));

const userMessage = (messageId: string, parentMessageId = Constants.NO_PARENT) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    sender: 'User',
    text: messageId,
  }) as TMessage;

const assistantMessage = (
  messageId: string,
  parentMessageId: string,
  extra: Partial<TMessage> = {},
) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: false,
    sender: 'Assistant',
    text: messageId,
    ...extra,
  }) as TMessage;

describe('abort cleanup', () => {
  it('removes preliminary assistant placeholders while keeping real messages', () => {
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1_', 'user-1', {
        createdAt: '2026-06-11T00:00:00.000Z',
      }),
      userMessage('user-2', 'assistant-1_'),
      assistantMessage('user-2_', 'user-2'),
      assistantMessage('progress-message', 'user-2', { unfinished: true }),
    ];

    expect(removeAbortPlaceholderMessages(messages).map((message) => message.messageId)).toEqual([
      'user-1',
      'assistant-1_',
      'user-2',
    ]);
  });

  it('cleans current conversation state without touching other active jobs', () => {
    const queryClient = new QueryClient();
    const conversationId = 'conversation-1';
    const messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1', {
        createdAt: '2026-06-11T00:00:00.000Z',
      }),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('user-2_', 'user-2'),
    ];
    const setMessages = jest.fn();

    queryClient.setQueryData([QueryKeys.activeJobs], {
      activeJobIds: [conversationId, 'conversation-2'],
    });
    queryClient.setQueryData(['streamStatus', conversationId], { active: true });
    queryClient.setQueryData([QueryKeys.messages, Constants.NEW_CONVO], []);

    cleanupAbortedResumableConversation({
      conversationId,
      queryClient,
      getMessages: () => messages,
      setMessages,
    });

    const cleanedMessages = messages.slice(0, 3);

    expect(setMessages).toHaveBeenCalledWith(cleanedMessages);
    expect(queryClient.getQueryData([QueryKeys.messages, conversationId])).toEqual(cleanedMessages);
    expect(queryClient.getQueryData<{ activeJobIds: string[] }>([QueryKeys.activeJobs])).toEqual({
      activeJobIds: ['conversation-2'],
    });
    expect(queryClient.getQueryData(['streamStatus', conversationId])).toBeUndefined();
    expect(
      queryClient.getQueryState([QueryKeys.messages, Constants.NEW_CONVO])?.isInvalidated,
    ).toBe(true);
  });
});

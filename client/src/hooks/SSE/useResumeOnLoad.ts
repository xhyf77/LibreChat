import { useEffect, useRef } from 'react';
import { useSetRecoilState, useRecoilValue, useRecoilCallback } from 'recoil';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  tMessageSchema,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TMessage, TConversation, TSubmission, Agents } from 'librechat-data-provider';
import type { ActiveJobsResponse, StreamStatusResponse } from '~/data-provider';
import { getBranchSiblingIndexesForTarget } from '~/utils';
import { streamStatusQueryKey, useStreamStatus } from '~/data-provider';
import store from '~/store';

function hasSubmissionUserMessage(
  submission: TSubmission | null,
  messages: TMessage[] | undefined,
  conversationId: string | undefined,
): boolean {
  const userMessageId = submission?.userMessage?.messageId;
  if (!userMessageId || !conversationId || !messages?.length) {
    return false;
  }

  return messages.some(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === userMessageId &&
      message.conversationId === conversationId,
  );
}

function resumeStateMatchesSubmission(
  streamStatus: StreamStatusResponse | undefined,
  submission: TSubmission | null,
): boolean {
  const resumeState = streamStatus?.resumeState;
  if (!resumeState || !submission) {
    return false;
  }

  const userMessageId = submission.userMessage?.messageId;
  if (userMessageId && resumeState.userMessage?.messageId === userMessageId) {
    return true;
  }

  const responseMessageId = submission.initialResponse?.messageId;
  return !!responseMessageId && resumeState.responseMessageId === responseMessageId;
}

function getResumeBranchTargetMessageId(
  resumeState: Agents.ResumeState,
  messages: TMessage[],
): string | null | undefined {
  const responseMessageId = resumeState.responseMessageId;
  if (!responseMessageId) {
    return resumeState.userMessage?.parentMessageId;
  }

  const unpaddedResponseMessageId = responseMessageId.replace(/_+$/, '');
  let hasResponseMessage = false;
  let hasUnpaddedResponseMessage = false;

  for (const message of messages) {
    if (message.messageId === responseMessageId) {
      hasResponseMessage = true;
      break;
    }

    if (message.messageId === unpaddedResponseMessageId) {
      hasUnpaddedResponseMessage = true;
    }
  }

  if (hasResponseMessage) {
    return responseMessageId;
  }

  if (hasUnpaddedResponseMessage) {
    return unpaddedResponseMessageId;
  }

  return resumeState.userMessage?.parentMessageId;
}

function preferDefinedString(value?: string | null, fallback?: string): string | undefined {
  return value != null && value !== '' ? value : fallback;
}

function hasCachedActiveJob(queryClient: QueryClient, conversationId: string | undefined): boolean {
  if (!conversationId) {
    return false;
  }

  const activeJobs = queryClient.getQueryData<ActiveJobsResponse>([QueryKeys.activeJobs]);
  return activeJobs?.activeJobIds?.includes(conversationId) === true;
}

function refreshCompletedStreamQueries(queryClient: QueryClient, conversationId: string) {
  queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
    activeJobIds: (old?.activeJobIds ?? []).filter((jobId) => jobId !== conversationId),
  }));

  queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, Constants.NEW_CONVO] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.conversation, conversationId] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });
  queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(conversationId) });
}

/**
 * Build a submission object from resume state for reconnected streams.
 * This provides the minimum data needed for useResumableSSE to subscribe.
 */
function buildSubmissionFromResumeState(
  resumeState: Agents.ResumeState,
  streamId: string,
  messages: TMessage[],
  conversationId: string,
): TSubmission {
  const userMessageData = resumeState.userMessage;
  const responseMessageId =
    resumeState.responseMessageId ?? `${userMessageData?.messageId ?? 'resume'}_`;

  // Try to find existing user message in the messages array (from database)
  const existingUserMessage = messages.find(
    (m) => m.isCreatedByUser && m.messageId === userMessageData?.messageId,
  );

  // Try to find existing response message in the messages array (from database)
  const existingResponseMessage = messages.find(
    (m) =>
      !m.isCreatedByUser &&
      (m.messageId === responseMessageId || m.parentMessageId === userMessageData?.messageId),
  );

  // Create or use existing user message
  const userMessage: TMessage =
    existingUserMessage ??
    (userMessageData
      ? (tMessageSchema.parse({
          messageId: userMessageData.messageId,
          parentMessageId: userMessageData.parentMessageId ?? Constants.NO_PARENT,
          conversationId: userMessageData.conversationId ?? conversationId,
          text: userMessageData.text ?? '',
          isCreatedByUser: true,
          role: 'user',
        }) as TMessage)
      : (messages[messages.length - 2] ??
        ({
          messageId: 'resume_user_msg',
          conversationId,
          text: '',
          isCreatedByUser: true,
        } as TMessage)));

  // ALWAYS use aggregatedContent from resumeState - it has the latest content from the running job.
  // DB content may be stale (saved at disconnect, but generation continued).
  const initialResponse: TMessage = {
    messageId: existingResponseMessage?.messageId ?? responseMessageId,
    parentMessageId: existingResponseMessage?.parentMessageId ?? userMessage.messageId,
    conversationId,
    text: '',
    // aggregatedContent is authoritative - it reflects actual job state
    content: (resumeState.aggregatedContent as TMessage['content']) ?? [],
    isCreatedByUser: false,
    role: 'assistant',
    sender: existingResponseMessage?.sender ?? resumeState.sender,
    model: preferDefinedString(existingResponseMessage?.model, resumeState.model),
    iconURL: preferDefinedString(existingResponseMessage?.iconURL, resumeState.iconURL),
  } as TMessage;

  const conversation: TConversation = {
    conversationId,
    title: 'Resumed Chat',
    endpoint: null,
  } as TConversation;

  return {
    messages,
    userMessage,
    initialResponse,
    conversation,
    isRegenerate: false,
    isTemporary: false,
    endpointOption: {},
    // Signal to useResumableSSE to subscribe to existing stream instead of starting new
    resumeStreamId: streamId,
  } as TSubmission & { resumeStreamId: string };
}

/**
 * Hook to resume streaming if navigating to a conversation with active generation.
 * Checks stream status via React Query and sets submission if active job found.
 *
 * This hook:
 * 1. Uses useStreamStatus to check for active jobs on navigation
 * 2. If active job found, builds a submission with streamId and sets it
 * 3. useResumableSSE picks up the submission and subscribes to the stream
 *
 * @param messagesLoaded - Whether the messages query has finished loading (prevents race condition)
 */
export default function useResumeOnLoad(
  conversationId: string | undefined,
  getMessages: () => TMessage[] | undefined,
  runIndex = 0,
  messagesLoaded = true,
) {
  const queryClient = useQueryClient();
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const currentSubmission = useRecoilValue(store.submissionByIndex(runIndex));
  const currentConversation = useRecoilValue(store.conversationByIndex(runIndex));
  const endpoint = currentConversation?.endpoint;
  const endpointType = currentConversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const resumableEnabled = !isAssistantsEndpoint(actualEndpoint);
  // Track conversations we've already processed (either resumed or skipped)
  const processedConvoRef = useRef<string | null>(null);
  const restoreResumeBranch = useRecoilCallback(
    ({ set }) =>
      (resumeState: Agents.ResumeState, messages: TMessage[], activeConversationId: string) => {
        const targetMessageId = getResumeBranchTargetMessageId(resumeState, messages);
        const branchIndexes = getBranchSiblingIndexesForTarget(
          messages,
          targetMessageId,
          activeConversationId,
        );

        for (const { parentMessageId, siblingIdx } of branchIndexes) {
          set(store.messagesSiblingIdxFamily(parentMessageId), siblingIdx);
        }
      },
    [],
  );

  // Check for active stream when conversation changes
  const submissionConvoId = currentSubmission?.conversation?.conversationId;
  const loadedMessages = messagesLoaded ? getMessages() : undefined;
  const hasExplicitSubmissionMatch = !!conversationId && submissionConvoId === conversationId;
  const hasHydratedMessageMatch =
    submissionConvoId == null &&
    hasSubmissionUserMessage(currentSubmission, loadedMessages, conversationId);
  const hasActiveSubmissionForThisConvo =
    !!currentSubmission && (hasExplicitSubmissionMatch || hasHydratedMessageMatch);
  const hasStaleSubmissionForDifferentConvo =
    !!currentSubmission && submissionConvoId != null && submissionConvoId !== conversationId;
  const hadCachedActiveJobForThisConvo = hasCachedActiveJob(queryClient, conversationId);
  const resumeStreamId = (currentSubmission as (TSubmission & { resumeStreamId?: string }) | null)
    ?.resumeStreamId;
  const hasResumeSubmissionForThisConvo = !!resumeStreamId && hasActiveSubmissionForThisConvo;

  const shouldCheck =
    resumableEnabled &&
    messagesLoaded && // Wait for messages to load before checking
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO;

  const {
    data: streamStatus,
    isSuccess,
    isFetching,
  } = useStreamStatus(conversationId, shouldCheck);

  useEffect(() => {
    console.log('[ResumeOnLoad] Effect check', {
      resumableEnabled,
      conversationId,
      messagesLoaded,
      hasCurrentSubmission: !!currentSubmission,
      currentSubmissionConvoId: currentSubmission?.conversation?.conversationId,
      isSuccess,
      isFetching,
      streamStatusActive: streamStatus?.active,
      streamStatusStreamId: streamStatus?.streamId,
      hadCachedActiveJobForThisConvo,
      hasResumeSubmissionForThisConvo,
      processedConvoRef: processedConvoRef.current,
    });

    if (!resumableEnabled || !conversationId || conversationId === Constants.NEW_CONVO) {
      console.log('[ResumeOnLoad] Skipping - not enabled or new convo');
      return;
    }

    // Wait for messages to load to avoid race condition where sync overwrites then DB overwrites
    if (!messagesLoaded) {
      console.log('[ResumeOnLoad] Waiting for messages to load');
      return;
    }

    // If there's a stale submission for a different conversation, log it but continue
    if (hasStaleSubmissionForDifferentConvo) {
      console.log(
        '[ResumeOnLoad] Found stale submission for different conversation, will check for resume',
        {
          staleConvoId: submissionConvoId,
          currentConvoId: conversationId,
        },
      );
    }

    // Wait for stream status query to complete (including background refetches
    // that may replace a stale cached result with fresh data)
    if (!isSuccess || !streamStatus || isFetching) {
      console.log('[ResumeOnLoad] Waiting for stream status query');
      return;
    }

    if (streamStatus.active && hasActiveSubmissionForThisConvo) {
      console.log('[ResumeOnLoad] Skipping - active submission still has active stream status', {
        streamId: streamStatus.streamId,
        currentConvoId: conversationId,
        userMessageId: currentSubmission?.userMessage?.messageId,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    if (
      streamStatus.active &&
      streamStatus.streamId &&
      submissionConvoId == null &&
      resumeStateMatchesSubmission(streamStatus, currentSubmission)
    ) {
      console.log('[ResumeOnLoad] Skipping - active submission matches stream status', {
        streamId: streamStatus.streamId,
        currentConvoId: conversationId,
        userMessageId: currentSubmission?.userMessage?.messageId,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    if (!streamStatus.active || !streamStatus.streamId) {
      console.log('[ResumeOnLoad] No active job to resume for:', conversationId);
      if (hadCachedActiveJobForThisConvo || hasResumeSubmissionForThisConvo) {
        console.log('[ResumeOnLoad] Refreshing completed stream data for:', conversationId);
        refreshCompletedStreamQueries(queryClient, conversationId);
        if (hasResumeSubmissionForThisConvo) {
          setSubmission(null);
        }
      }
      processedConvoRef.current = conversationId;
      return;
    }

    // Don't process the same conversation twice. Completed/inactive streams are
    // handled above so a job that finishes after navigation still refreshes.
    if (processedConvoRef.current === conversationId) {
      console.log('[ResumeOnLoad] Skipping - already processed this conversation');
      return;
    }

    processedConvoRef.current = conversationId;

    console.log('[ResumeOnLoad] Found active job, creating submission...', {
      streamId: streamStatus.streamId,
      status: streamStatus.status,
      resumeState: streamStatus.resumeState,
    });

    const messages = getMessages() || [];

    // Build submission from resume state if available
    if (streamStatus.resumeState) {
      restoreResumeBranch(streamStatus.resumeState, messages, conversationId);
      const submission = buildSubmissionFromResumeState(
        streamStatus.resumeState,
        streamStatus.streamId,
        messages,
        conversationId,
      );
      setSubmission(submission);
    } else {
      // Minimal submission without resume state
      const lastUserMessage = [...messages].reverse().find((m) => m.isCreatedByUser);
      const submission = {
        messages,
        userMessage:
          lastUserMessage ?? ({ messageId: 'resume', conversationId, text: '' } as TMessage),
        initialResponse: {
          messageId: 'resume_',
          conversationId,
          text: '',
          content: streamStatus.aggregatedContent ?? [{ type: 'text', text: '' }],
        } as TMessage,
        conversation: { conversationId, title: 'Resumed Chat' } as TConversation,
        isRegenerate: false,
        isTemporary: false,
        endpointOption: {},
        // Signal to useResumableSSE to subscribe to existing stream instead of starting new
        resumeStreamId: streamStatus.streamId,
      } as TSubmission & { resumeStreamId: string };
      setSubmission(submission);
    }
  }, [
    conversationId,
    resumableEnabled,
    messagesLoaded,
    hasActiveSubmissionForThisConvo,
    submissionConvoId,
    hadCachedActiveJobForThisConvo,
    hasResumeSubmissionForThisConvo,
    hasStaleSubmissionForDifferentConvo,
    currentSubmission,
    isSuccess,
    isFetching,
    streamStatus,
    getMessages,
    setSubmission,
    restoreResumeBranch,
    queryClient,
  ]);

  // Reset processedConvoRef when conversation changes to allow re-checking
  useEffect(() => {
    // Always reset when conversation changes - this allows resuming when navigating back
    if (conversationId !== processedConvoRef.current) {
      console.log('[ResumeOnLoad] Resetting processedConvoRef for new conversation:', {
        old: processedConvoRef.current,
        new: conversationId,
      });
      processedConvoRef.current = null;
    }
  }, [conversationId]);
}

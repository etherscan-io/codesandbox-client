import React from 'react';
import styled, { css } from 'styled-components';
import { Stack, Text, Element } from '@codesandbox/components';
import {
  SSEContainerStatus,
  SSEManagerStatus,
} from '@codesandbox/common/lib/types';
import { useOvermind } from 'app/overmind';

type StatusCircleProps = { theme: any; color: string };

const StatusCircle = styled.div`
  ${({ theme, color }: StatusCircleProps) => css`
    border-radius: 50%;
    background-color: ${color};
    width: ${theme.space[2]}px;
    height: ${theme.space[2]}px;
  `}
`;

const STATUS_MESSAGES = {
  initializing: 'Container is starting...',
  starting: 'Sandbox is starting...',
  started: 'Connected to sandbox',
  error: 'A sandbox error occurred',
  hibernated: 'Sandbox hibernated',
};

const STATUS_COLOR = {
  disconnected: '#FD2439',
  connected: '#4CFF00',
  initializing: '#FFD399',
  hibernated: '#FF662E',
  error: '#FD2439',
};

function getContainerStatusMessageAndColor(
  containerStatus: SSEContainerStatus
) {
  switch (containerStatus) {
    case 'initializing':
      return { color: '#FFD399', message: STATUS_MESSAGES.initializing };
    case 'container-started':
    case 'stopped':
      return { color: '#FFD399', message: STATUS_MESSAGES.starting };
    case 'sandbox-started':
      return { color: '#4CFF00', message: STATUS_MESSAGES.started };
    case 'error':
      return { color: '#FD2439', message: STATUS_MESSAGES.error };
    case 'hibernated':
      return { color: '#FF662E', message: STATUS_MESSAGES.hibernated };
    default:
      return undefined;
  }
}

function getManagerStatusMessageAndColor(managerStatus: SSEManagerStatus) {
  switch (managerStatus) {
    case 'connected':
    case 'disconnected':
      return undefined;
    case 'initializing':
      return {
        message: STATUS_MESSAGES.initializing,
        color: STATUS_COLOR.initializing,
      };
    default:
      return undefined;
  }
}

export const Status = () => {
  const {
    state: {
      server: { containerStatus, status: managerStatus },
    },
  } = useOvermind();
  const { color, message } =
    getManagerStatusMessageAndColor(managerStatus) ||
    getContainerStatusMessageAndColor(containerStatus);

  return (
    <Stack align="center">
      <Element marginX={2}>
        <StatusCircle color={color} />
      </Element>
      <Text marginLeft={2}>{message}</Text>
    </Stack>
  );
};

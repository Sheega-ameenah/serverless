'use strict';

const { writeText, style } = require('@serverless/utils/log');
const WebSocket = require('ws');
const chalk = require('chalk');
const resolveAuthMode = require('@serverless/utils/auth/resolve-mode');
const streamBuffers = require('stream-buffers');

const stage = process.env.SERVERLESS_PLATFORM_STAGE || 'prod';
const socketUrl =
  stage === 'prod'
    ? 'wss://ehst4ktjyi.execute-api.us-east-1.amazonaws.com/prod'
    : 'wss://4c684ym73e.execute-api.us-east-1.amazonaws.com/dev';

const streamBuff = new streamBuffers.ReadableStreamBuffer({
  frequency: 500,
  chunkSize: 2048 * 1000000,
});

const getDuration = (startTime, endTime) => {
  return new Date(endTime).getTime() - new Date(startTime).getTime();
};

const capitalizeFirstLetter = (string) => string.charAt(0).toUpperCase() + string.slice(1);

const formatDuration = (milliseconds) => {
  const seconds = milliseconds / 1000;
  const minutes = seconds / 60;

  if (milliseconds <= 999) {
    return `${Math.round(milliseconds)}ms`;
  } else if (seconds <= 59) {
    return `${Math.floor(seconds * 100) / 100}s`;
  } else if (minutes >= 1) {
    return `${Math.floor(minutes * 100) / 100}min`;
  }
  return 'n/a';
};

const formatAWSSDKName = ({ activity }) => {
  const { name } = activity;
  const [, , service, operation] = name.split('.');
  let finalName = `AWS SDK • ${capitalizeFirstLetter(service)} • ${operation.toUpperCase()}`;
  if (name.includes('aws.sdk.dynamodb')) {
    finalName = `AWS SDK • DynamoDB • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.eventbridge')) {
    finalName = `AWS SDK • Event Bridge • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.secretsmanager')) {
    finalName = `AWS SDK • Secrets Manager • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.kinesis')) {
    finalName = `AWS SDK • Kinesis • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.elastictranscoder')) {
    finalName = `AWS SDK • Elastic Transcoder • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.iotdata')) {
    finalName = `AWS SDK • IOT Data • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.kinesisvideo')) {
    finalName = `AWS SDK • Kinesis Video • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.sns')) {
    finalName = `AWS SDK • SNS • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.sqs')) {
    finalName = `AWS SDK • SQS • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.ssm')) {
    finalName = `AWS SDK • SSM • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.s3')) {
    finalName = `AWS SDK • S3 • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.elb')) {
    finalName = `AWS SDK • ELB • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.emr')) {
    finalName = `AWS SDK • EMR • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.es')) {
    finalName = `AWS SDK • ES • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.fms')) {
    finalName = `AWS SDK • FMS • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.ecs')) {
    finalName = `AWS SDK • ECS • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.ec2')) {
    finalName = `AWS SDK • EC2 • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.eks')) {
    finalName = `AWS SDK • EKS • ${operation.toUpperCase()}`;
  } else if (name.includes('aws.sdk.ebs')) {
    finalName = `AWS SDK • EBS • ${operation.toUpperCase()}`;
  }
  return {
    name: `${activity.durationFormatted ? `${activity.durationFormatted} • ` : ''}${finalName}`,
  };
};

const formatHTTPName = ({ activity }) => {
  let name = activity.durationFormatted ? `${activity.durationFormatted} • ` : '';
  name += 'HTTP';
  if (activity && activity.tags && activity.tags.http && activity.tags.http.method) {
    name += ` • ${activity.tags.http.method}`;
  }
  if (activity && activity.tags && activity.tags.http && activity.tags.http.path) {
    name += ` • ${activity.tags.http.path}`;
  }

  return {
    name,
  };
};

const formatSpan = (data = {}) => {
  // Add nice names for the span types
  if (data.startTime && data.endTime && !data.duration) {
    data.duration = getDuration(data.startTime, data.endTime);
    data.durationFormatted = data.duration ? formatDuration(data.duration) : null;
  }
  const name = data.name;
  if (/aws\.sdk/.test(name)) {
    const { name: niceName } = formatAWSSDKName({ activity: data });
    data.niceName = niceName;
  } else if (name && (name.includes('node.http.request') || name.includes('node.https.request'))) {
    const { name: niceName } = formatHTTPName({ activity: data });
    data.niceName = niceName;
  } else {
    data.niceName = data.name;
  }
  return data;
};

const formatDate = (date) => date.toTimeString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, '$1');

const omitAndSort = (array) => {
  return array
    .filter((data) => {
      /**
       * Don't include the following
       * - No timestamp
       * - Not a valid object type
       * - Not a aws.sdk or http span
       * - message is a string (This would be a filter message from the log socket service)
       */
      if (!data.timestamp || data.timestamp === '') {
        return false;
      } else if (
        !['span', 'log', 'aws-lambda-request', 'aws-lambda-response', 'event'].includes(data.type)
      ) {
        return false;
      } else if (data.type === 'span') {
        if (
          !data.name.startsWith('aws.sdk') &&
          !data.name.startsWith('node.http.request') &&
          !data.name.startsWith('node.https.request')
        ) {
          return false;
        }
      } else if (typeof data.message === 'string') {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      // If times are the same we should fall back to the sequenceId
      if (
        new Date(b.timestamp).getTime() === new Date(a.timestamp || 0).getTime() &&
        a.type === 'log' &&
        b.type === 'log' &&
        a.tags &&
        b.tags &&
        a.tags.aws &&
        b.tags.aws
      ) {
        return a.tags.aws.sequenceId - b.tags.aws.sequenceId;
      } else if (new Date(b.timestamp).getTime() === new Date(a.timestamp || 0).getTime()) {
        return a.sequenceId - b.sequenceId;
      }
      return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
    });
};

const handleSocketMessage = (data) => {
  try {
    const splitData = data.toString('utf-8').split(';;;');
    const jsonArray = splitData.reduce((arr, item) => {
      try {
        const parsedItem = JSON.parse(item);
        if (Array.isArray(parsedItem)) {
          return [...arr, ...parsedItem];
        }
        throw new Error('Not an array');
      } catch (error) {
        return arr;
      }
    }, []);
    if (!Array.isArray(jsonArray)) return;
    const sortedItems = omitAndSort(jsonArray);

    for (const activity of sortedItems) {
      const resourceName = ((activity.tags || {}).aws || {}).resourceName;
      const time = formatDate(new Date(activity.timestamp), 'HH:mm:ss.SSS');

      switch (activity.type) {
        case 'log':
          process.stdout.write(chalk.grey(`${time} • ${resourceName} • Log`));
          try {
            const parsedBody = JSON.parse(activity.body);
            if (typeof parsedBody === 'string') {
              throw new Error('Not a JSON object');
            }
            process.stdout.write(chalk.bold(`${JSON.stringify(parsedBody, null, 2)}`));
          } catch (error) {
            process.stdout.write(chalk.bold(`${activity.body}`));
          }
          break;
        case 'span': {
          const span = formatSpan(activity);
          process.stdout.write(chalk.grey(`${time} • ${resourceName} • Span • ${span.niceName}`));
          break;
        }
        case 'aws-lambda-request':
          process.stdout.write(chalk.grey(`${time} • ${resourceName} • Invocation Started`));
          break;
        case 'aws-lambda-response':
          process.stdout.write(chalk.grey(`${time} • ${resourceName} • Invocation Ended`));
          break;
        case 'event':
          break;
        default:
      }
    }
  } catch (error) {
    process.stdout.write(error);
  }
};

const connectToWebSocket = (functionName) => {
  const ws = new WebSocket(`${socketUrl}?Auth=55a2ed2e-257a-42cb-8245-ea5d25cd33a2`, {
    perMessageDeflate: false,
  });

  ws.on('open', () => {
    writeText(style.aside('Waiting for dev mode activity...\n'));
    ws.send(JSON.stringify({ filters: { functionName } }));
  });
  ws.on('message', (data) => {
    streamBuff.put(`${data.toString('utf-8')};;;`);
  });
  return ws;
};

module.exports = {
  async isApplicable(context) {
    const { isConsole, launchDev, deployNeeded } = context;

    if (!isConsole) {
      context.inapplicabilityReasonCode = 'NON_CONSOLE_CONTEXT';
      return false;
    }

    if (!launchDev) {
      context.inapplicabilityReasonCode = 'NON_LAUNCH_DEV_CONTEXT';
      return false;
    }

    if (deployNeeded) {
      context.inapplicabilityReasonCode = 'NEEDS_DEPLOY';
      return false;
    }

    if (!(await resolveAuthMode())) {
      context.inapplicabilityReasonCode = 'NOT_LOGGED_IN';
      return false;
    }

    if (!context.org) {
      context.inapplicabilityReasonCode = 'UNRESOLVED_ORG';
      return false;
    }

    return true;
  },

  async run(context) {
    streamBuff.on('data', handleSocketMessage);
    const ws = connectToWebSocket(context.targetFunctions);
    // Only open for 5 minutes
    setTimeout(() => {
      ws.close();
    }, 1000 * 60 * 5);
  },
  configuredQuestions: ['shouldSetupConsoleIamRole'],
};

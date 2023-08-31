// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  aws_dynamodb as dynamodb,
  CfnOutput,
  RemovalPolicy,
  aws_ecr_assets as ecr_assets,
  aws_eks as eks,
  Stack,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EventBus } from "aws-cdk-lib/aws-events";
import { EventbridgeToSqs } from "@aws-solutions-constructs/aws-eventbridge-sqs";
import { SettlementEvents } from "../../settlement/infra/settlement-service";
import * as blueprints from '@aws-quickstart/eks-blueprints';

import * as path from "path";

export enum VendorEvents {
  SOURCE = "vendor.service",
  VENDOR_FINALIZED = "Vendor.Finalized",
}

interface VendorServiceProps {
  readonly bus: EventBus,
}

export class VendorService extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: VendorServiceProps) {
    super(scope, id);

    //const account = props?.env?.account!;
    //const region = props?.env?.region!;

    /*this.table = new dynamodb.Table(this, "VendorTable", {
      partitionKey: { name: "Id", type: dynamodb.AttributeType.STRING, },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code
    });*/

    const ebToSqsConstruct = new EventbridgeToSqs(this, 'sqs-construct', {
      existingEventBusInterface: props.bus,
      eventRuleProps: {
        eventPattern: {
          source: [SettlementEvents.SOURCE],
          detailType: [SettlementEvents.SETTLEMENT_FINALIZED],
        }
      },
      queueProps: {
        queueName: `${Stack.of(this).stackName}-EBTarget`
      }
    });

    const queue = ebToSqsConstruct.sqsQueue;

    const kedaParams = {
      podSecurityContextFsGroup: 1001,
      securityContextRunAsGroup: 1001,
      securityContextRunAsUser: 1001,
      irsaRoles: ["CloudWatchFullAccess", "AmazonSQSFullAccess"],
    };
    
    const addOn = new blueprints.KedaAddOn(kedaParams);
    const vendorClusterName = id+'-stack';

    const blueprint = blueprints.EksBlueprint.builder()
    .version(eks.KubernetesVersion.V1_26)
    .account('963366896292')
    //.region()
    .addOns(addOn)
    .teams()
    .build(scope, vendorClusterName);

    const cluster = eks.Cluster.fromClusterAttributes(this, vendorClusterName, {
      clusterName: vendorClusterName
    });

    cluster.addManifest('KEDA', {
      apiVersion: 'mkeda.sh/v1alpha1',
      kind: 'ScaledObject',
      metadata: {
        name: 'aws-sqs-queue-scaledobject',
        namespace: 'default',
      },
      spec: {
        scaleTargetRef: {
          name: vendorClusterName,
        },
        pollingInterval: 5,
        cooldownPeriod: 10,
        idleReplicaCount: 0,
        minReplicaCount: 1,
        maxReplicaCount: 3,
        failureThreshold: 5,
      },
      replicas: 2,
      triggers: {
        type: 'aws-sqs-queue',
        authenticationRef: {
          name: 'keda-trigger-auth-aws-credentials',
        },
        metadata: {
          queueURL: queue.queueUrl,
          queueLength: '5',
          identityOwner: 'operator',
        },
      },
    });
    // move to separate file
    const ecrAsset = new ecr_assets.DockerImageAsset(this, "vendor-service", {
      directory: path.join(__dirname, "../app"),
    });

    cluster.addManifest('vendor-service', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'vendor-service',
        namespace: 'default',
      },
      spec: {
        replicas: 2,
        selector: {
          matchLabels: {
            app: 'vendor-service',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'vendor-service',
            },
          },
          spec: {
            containers: {
              name: 'vendor-service',
              image: ecrAsset.imageUri,
              ports: {
                containerPort: 3000,
              },
              env: [ {name: 'VENDOR_QUEUE', value: queue.queueUrl}, {name: 'BUS_NAME', value: props.bus.eventBusName}],
            /*- env:
              - name: var1
                value: val1
              - name: var2
                value: val2 */
            },
          },
        },
      },
    });
    
 // get handle to cluster and deploy yml
    new CfnOutput(this, "EventBridge: ", { value: props.bus.eventBusName });
    new CfnOutput(this, "SQS-Queue: ", { value: queue.queueName });
  }
}

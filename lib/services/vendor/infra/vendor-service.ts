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
import { SettlementEvents } from "../../settlement/infra/settlement-events";
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

    const account = props?.env?.account!;
    const region = props?.env?.region!;

    this.table = new dynamodb.Table(this, "VendorTable", {
      partitionKey: { name: "Id", type: dynamodb.AttributeType.STRING, },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code
    });

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

    const asset = new ecr_assets.DockerImageAsset(this, "vendor-service", {
      directory: path.join(__dirname, "../app"),
    });

    const kedaParams = {
      podSecurityContextFsGroup: 1001,
      securityContextRunAsGroup: 1001,
      securityContextRunAsUser: 1001,
      irsaRoles: ["CloudWatchFullAccess", "AmazonSQSFullAccess"],
    };
    
    const addOn = new blueprints.KedaAddOn(kedaParams);
    
    const blueprint = blueprints.EksBlueprint.builder()
    .account(account)
    .region(region)
    .addOns(addOn)
    .teams()
    .build(scope, id+'-stack');

    const cluster = eks.Cluster.fromClusterAttributes(this, id+'-stack', {
      clusterName: id+'-stack'
    });

    cluster.addManifest('KEDA', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'myconfigmap',
      },
      data: {
        Key: 'value',
        Another: '123454',
      },
    });

    cluster.addManifest('Test', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'myconfigmap',
      },
      data: {
        Key: 'value',
        Another: '123454',
      },
    });

 // get handle to cluster and deploy yml
    new CfnOutput(this, "EventBridge: ", { value: props.bus.eventBusName });
    new CfnOutput(this, "SQS-Queue: ", { value: queue.queueName });
  }
}

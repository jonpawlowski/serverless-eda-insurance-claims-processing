
// Load the AWS SDK for Node.js
const AWS = require('aws-sdk');
const { Consumer } = require('sqs-consumer');
require('dotenv').config();

// Set the region
AWS.config.update({region: process.env.AWS_REGION});
const eventBridge = new AWS.EventBridge({apiVersion: '2015-10-07', region: process.env.AWS_REGION});

const queueURL = process.env.VENDOR_QUEUE;

const ebParams = {
    Entries: [
      {
        Source: 'vendor.service', // Must match with the source defined in rules
        Detail: '{ \"message\": \"Vendor finalized. Enterprise Rental Car was chosen.\" }',
        DetailType: 'Vendor.Finalized',
      },
    ],
};
  
const app = Consumer.create({
  queueUrl: queueURL,
  handleMessage: async (message) => {
  	let event = JSON.parse(message.Body);
    console.log(event);
    
    // Sent processed messages back to EventBridge bus
	eventBridge.putEvents(ebParams, function(err, data) {
	  if (err) {
        console.log("Error", err);
      } else {
        console.log("Success", data.Entries);
      }
    });
  }
});

app.on('error', (err) => {
  console.error(err.message);
});

app.on('processing_error', (err) => {
  console.error(err.message);
});

app.start();
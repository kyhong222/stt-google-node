const { Writable, Readable } = require("stream");
const speech = require("@google-cloud/speech").v1p1beta1;
const PROTO_PATH = "src/protos/STTStream.proto";
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const fs = require("fs");

let encoding;
let sampleRateHertz;
let languageCode;
let profanityFilter;
let enableWordTimeOffsets;

let interimResults;
let singleUtterance;

let speechContexts;

let port;

let projectId;
let credentialFilename = "googleCredential.json";
let bufferSplitSize;

const authCredential = {
  projectId: projectId,
  keyFilename: credentialFilename,
};

const STTStreams = new Map();
const STTTranscrips = new Map();

function readConfig() {
  const jsonFile = fs.readFileSync("config.json", "utf8");
  const jsonData = JSON.parse(jsonFile);
  // console.log(jsonData);
  console.log("config.json read successfully");

  const googleCredential = fs.readFileSync("googleCredential.json", "utf8");
  const googleCredentialData = JSON.parse(googleCredential);
  console.log("googleCredential.json read successfully");

  projectId = googleCredentialData.project_id;

  encoding = jsonData.encoding || "LINEAR16";
  sampleRateHertz = parseInt(jsonData.sampleRateHertz) || 8000;
  languageCode = jsonData.languageCode || "ko-KR"; // en-US is able
  profanityFilter = jsonData.profanityFilter || false;
  enableWordTimeOffsets = jsonData.enableWordTimeOffsets || true;
  speechContexts = jsonData.speechContexts || [];

  interimResults = true; // essential
  singleUtterance = true; // essential

  port = parseInt(jsonData.port) || 50051;
  bufferSplitSize = parseInt(jsonData.bufferSplitSize) || 1600;
}

function startRecognitionStream(speechClient, callId) {
  const request = {
    config: {
      encoding: encoding,
      sampleRateHertz: sampleRateHertz,
      languageCode: languageCode,
      profanityFilter: profanityFilter,
      enableWordTimeOffsets: enableWordTimeOffsets,
      speechContexts: speechContexts,
    },
    interimResults: interimResults, // If you want interim results, set this to true
    singleUtterance: singleUtterance,
  };

  STTStreams[callId] = speechClient
    .streamingRecognize(request)
    .on("error", console.error)
    .on("data", (data) => {
      // STT 디버그 로그
      // console.log("data", data);
      // if (data.results.length) {
      //   console.log(data.results[0].alternatives[0].transcript);
      //   console.log(data.results[0].isFinal);
      // }

      if (data.results[0] && data.results[0].isFinal) {
        STTTranscrips[callId] = {
          isFinal: data.results[0].isFinal,
          transcript: data.results[0].alternatives[0].transcript,
        };
      }

      // if end of utterance, let's restart stream
      // this is a small hack. After 65 seconds of silence, the stream will still throw an error for speech length limit
      if (
        (data.results[0] && data.results[0].isFinal) ||
        data.speechEventType === "END_OF_SINGLE_UTTERANCE"
      ) {
        stopRecognitionStream(callId);
        startRecognitionStream(speechClient, callId);
        console.log(`restarted stream ${callId}`);
      }
    });
}

function stopRecognitionStream(callId) {
  if (STTStreams[callId]) {
    STTStreams[callId].end();
  }
  STTStreams[callId] = undefined;
}

function restartRecognitionStream(callId) {
  stopRecognitionStream(callId);
  newClient = createStream();
  STTStreams[callId] = newClient;
  startRecognitionStream(newClient, callId);
  console.log(`restarted stream ${callId}`);
}

function app() {
  readConfig();
  // gRPC init
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const routes = protoDescriptor.STTStream; // this is gRPC routes

  // gRPC server start
  const server = new grpc.Server();
  server.addService(routes.stream.service, {
    createStreamRPC: createStreamRPC,
    sendStreamRPC: sendStreamRPC,
    endStreamRPC: endStreamRPC,
    restartStreamRPC: restartStreamRPC,
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    () => {
      server.start();
    }
  );

  console.log(`Google STT server is listening on ${port}`);
  // console.log(server);
}

function createStreamRPC(call, callback) {
  console.log(call.request);
  const newStream = createStream();
  // STTStreams[call.request.callId] = null;
  startRecognitionStream(newStream, call.request.callId);
  STTTranscrips[call.request.callId] = {
    isFinal: false,
    transcript: "",
  };
  callback(null, {
    message: `createStream: ${call.request.callId} requests to create, \"${call.request.message}\"`,
  });
}

function sendStreamRPC(call) {
  // console.log(call);
  call.on("data", function (streamBuffers) {
    // 버퍼 캡쳐 로그기능
    // console.log(new Date(), `Receive ${streamBuffers.buffers.length} bytes`);

    if (STTStreams[streamBuffers.callId] !== undefined) {
      // console.log("origin:", streamBuffers.buffers);
      const splitedBuffer = bufferSplit(streamBuffers.buffers);
      for (let i = 0; i < splitedBuffer.length; i++) {
        // console.log("splited:", splitedBuffer[i]);
        STTStreams[streamBuffers.callId].write(splitedBuffer[i]);
      }
    }

    /* For each note sent, respond with all previous notes that correspond to
     * the same point */
    if (STTTranscrips[streamBuffers.callId].isFinal) {
      const responseStreamMessage = {
        callId: streamBuffers.callId,
        message: STTTranscrips[streamBuffers.callId].transcript,
      };
      console.log(new Date(), responseStreamMessage);

      call.write(responseStreamMessage);
      STTTranscrips[streamBuffers.callId] = {
        isFinal: false,
        transcript: "",
      };
    }
  });
  call.on("end", function () {
    call.end();
  });
}

function endStreamRPC(call, callback) {
  console.log(call.request);
  stopRecognitionStream(call.request.callId);
  callback(null, {
    callId: call.request.callId,
    message: `STT stream ${call.request.callId} was ended successfully`,
  });
}

function restartStreamRPC(call, callback) {
  console.log(call.request);
  const key = call.request.callId;
  restartRecognitionStream(key);
  callback(null, {
    callId: call.request.callId,
    message: `STT stream ${call.request.callId} was restart successfully`,
  });
}

// triggered on createStreamRPC
// returns stream object
// it will be managed on streams map
const createStream = () => {
  const client = new speech.SpeechClient(authCredential);
  // const client = new speech.SpeechClient();

  return client;
};

function bufferSplit(buffers) {
  const splitSize = bufferSplitSize;
  const chunkSize = Math.ceil(buffers.length / splitSize);
  const chunk = [];
  for (let i = 0; i < chunkSize - 1; i++) {
    chunk.push(buffers.slice(splitSize * i, splitSize * (i + 1)));
  }
  chunk.push(buffers.slice(splitSize * (chunkSize - 1), buffers.length));

  return chunk;
}

// execute app
app();

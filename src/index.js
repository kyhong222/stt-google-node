const { Writable, Readable } = require("stream");
const speech = require("@google-cloud/speech").v1p1beta1;
const PROTO_PATH = "src/protos/STTStream.proto";
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const encoding = "LINEAR16";
const sampleRateHertz = 8000;
const languageCode = "ko-KR"; //en-US

const request = {
  config: {
    encoding: encoding,
    sampleRateHertz: sampleRateHertz,
    languageCode: languageCode,
    profanityFilter: false,
    enableWordTimeOffsets: true,
    // speechContexts: [{
    //     phrases: ["hoful","shwazil"]
    //    }] // add your own speech context for better recognition
  },
  interimResults: true, // If you want interim results, set this to true
  singleUtterance: true,
};

const authCredential = {
  projectId: "still-manifest-340609",
  keyFilename: "/home/daydream/stt-google-node/googleCredential.json",
};

const STTStreams = new Map();
const STTTranscrips = new Map();

function startRecognitionStream(speechClient, callId) {
  STTStreams[callId] = speechClient
    .streamingRecognize(request)
    .on("error", console.error)
    .on("data", (data) => {
      // console.log(data);
      if (data.results.length) {
        console.log(data.results[0].alternatives[0].transcript);
        console.log(data.results[0].isFinal);
      }

      if (data.results[0] && data.results[0].isFinal) {
        STTTranscrips[callId] = {
          isFinal: data.results[0].isFinal,
          transcript: data.results[0].alternatives[0].transcript,
        };
      }

      // if end of utterance, let's restart stream
      // this is a small hack. After 65 seconds of silence, the stream will still throw an error for speech length limit
      if (data.results[0] && data.results[0].isFinal) {
        stopRecognitionStream(callId);
        startRecognitionStream(speechClient, callId);
        console.log("restarted stream serverside");
      }
    });
}

function stopRecognitionStream(callId) {
  if (STTStreams[callId]) {
    STTStreams[callId].end();
  }
  STTStreams[callId] = undefined;
}

function app() {
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
  });

  server.bindAsync(
    "0.0.0.0:50051",
    grpc.ServerCredentials.createInsecure(),
    () => {
      server.start();
    }
  );

  console.log(`STT server is listening on ${50051}`);
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
    console.log(new Date(), `Receive ${streamBuffers.buffers.length} bytes`);

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
      console.log(responseStreamMessage);

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

// triggered on createStreamRPC
// returns stream object
// it will be managed on streams map
const createStream = () => {
  const client = new speech.SpeechClient(authCredential);
  // const client = new speech.SpeechClient();

  return client;
};

function bufferSplit(buffers) {
  const splitSize = 1600;
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

import express from 'express';
import { graphqlHTTP } from 'express-graphql';
import fs from 'fs';
import multer from 'multer';

import { basicAuthRouter } from './basic-auth';
import githubApi from './github-api';
import gitlabApi from './gitlab-api';
import { root, schema } from './graphql';
import { startGRPCServer } from './grpc';
import { oauthRoutes } from './oauth';

const app = express();
const port = 4010;
const grpcPort = 50051;

app.get('/pets/:id', (req, res) => {
  res.status(200).send({ id: req.params.id });
});

app.get('/sleep', (_req, res) => {
  res.status(200).send({ sleep: true });
});

app.get('/cookies', (_req, res) => {
  res
    .status(200)
    .header('content-type', 'text/plain')
    .cookie('insomnia-test-cookie', 'value123')
    .send(`${_req.headers['cookie']}`);
});

app.use('/file', express.static('fixtures/files'));

app.use('/auth/basic', basicAuthRouter);

githubApi(app);
gitlabApi(app);

app.get('/delay/seconds/:duration', (req, res) => {
  const delaySec = Number.parseInt(req.params.duration || '2');
  setTimeout(function() {
    res.send(`Delayed by ${delaySec} seconds`);
  }, delaySec * 1000);
});

app.use('/oidc', oauthRoutes(port));

app.get('/', (_req, res) => {
  res.status(200).send();
});

app.use('/graphql', graphqlHTTP({
  schema: schema,
  rootValue: root,
  graphiql: true,
}));

// app.get('/multipart-response', (_, res) => {
//   var form = new FormData();
//   form.append('part1', 'part 1 data');
//   form.append('part2', 'part 2 data');
//   res.setHeader('x-Content-Type', 'multipart/form-data; boundary='+form._boundary);
//   res.setHeader('Content-Type', 'text/plain');
//   form.pipe(res);
// });

app.get('/multipart-form', (_, res) => {
  res.send(`<form action="http://localhost:4010/upload-multipart" method="post" enctype="multipart/form-data">
<p><input type="text" name="text" value="some text">
<p><input type="file" name="fileToUpload">
<p><button type="submit">Submit</button>
</form>`);
});

const upload = multer({ dest: './public/data/uploads/' });
app.post('/upload-multipart', upload.single('fileToUpload'), (req, res) => {
  // req.file is the name of your file in the form above, here 'uploaded_file'
  // req.body will hold the text fields, if there were any
  console.log(req.file, req.body);

  if (req.file?.fieldname !== 'fileToUpload') {
    return res.status(500).send('must include file');
  }
  const isMimetypeReadable = !!['yaml', 'json', 'xml'].filter(x => req.file?.mimetype.includes(x)).length;
  const fileContents = !isMimetypeReadable ? '' : fs.readFileSync(req.file?.path).toString();
  return res.status(200).send(JSON.stringify(req.file, null, '\t') + `
${fileContents}`);
});

// HTTP Redirect
app.get('/from', (_, res) => res.redirect(301, '/to'));
app.get('/to', (_, res) => res.send('Hello, World!'));

startGRPCServer(grpcPort).then(() => {
  app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
  });
});

#!/bin/bash

chown -R 1000:1000 /app

gosu node ./node_modules/.bin/prisma db push --accept-data-loss --skip-generate
gosu node node --enable-source-maps build/index.js

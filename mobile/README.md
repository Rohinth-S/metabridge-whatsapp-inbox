# MetaBridge mobile client boundary

This folder contains the typed network boundary used by an Expo/React Native client. Keep screens thin: authentication state, offline queueing, and optimistic UI should call `request()` rather than embedding HTTP details.

Example:

```ts
const rows = await listMessages({baseUrl: "http://localhost:4030", token});
```

The API is deliberately usable from a mobile device on a local network; set `baseUrl` to the host machine address when testing on a physical device.

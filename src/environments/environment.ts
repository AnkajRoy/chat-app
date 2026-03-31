export const environment = {
  production: false,
  useFirebase: true, // true = Firebase, false = Gun.js
  gunPeers: [
    'https://gun-manhattan.herokuapp.com/gun',
    'https://gun-us.herokuapp.com/gun',
    // Add your own Gun.js relay server URL here
  ],
  firebase: {
    apiKey: 'AIzaSyAw0EVvp4PftTtHsR73aO7rjfQUnKTWTBQ',
    authDomain: 'chat-app-4bbe0.firebaseapp.com',
    databaseURL: 'https://chat-app-4bbe0-default-rtdb.firebaseio.com',
    projectId: 'chat-app-4bbe0',
    storageBucket: 'chat-app-4bbe0.firebasestorage.app',
    messagingSenderId: '398631843469',
    appId: '1:398631843469:web:6725ebfc4f49468f4014c4',
    measurementId: 'G-GRPMNLKS6J'
  }
};

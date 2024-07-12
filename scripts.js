const backendUrl = 'https://your-backend-url.com/api/auth';

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch(`${backendUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      window.location.href = 'dashboard.html';
    } else {
      document.getElementById('loginMessage').textContent = data.message;
    }
  } catch (err) {
    console.error(err);
    document.getElementById('loginMessage').textContent = 'Error logging in';
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch(`${backendUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    document.getElementById('registerMessage').textContent = data.message;
  } catch (err) {
    console.error(err);
    document.getElementById('registerMessage').textContent = 'Error registering';
  }
});

async function fetchUserData() {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  try {
    const res = await fetch(`${backendUrl}/me`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    const user = await res.json();
    if (user) {
      document.getElementById('username').textContent = user.username;
      document.getElementById('level').textContent = user.level || 1;
      document.getElementById('health').textContent = user.health || 100;
      document.getElementById('balance').textContent = user.balance || 0;
    }
  } catch (err) {
    console.error(err);
    window.location.href = 'login.html';
  }
}

if (window.location.pathname.endsWith('dashboard.html')) {
  fetchUserData();
}

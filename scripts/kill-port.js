const { exec } = require('child_process');
const os = require('os');

const port = process.argv[2] || process.env.PORT || 3000;

console.log(`Checking for processes using port ${port}...`);

function killPort(port) {
    const platform = os.platform();
    
    if (platform === 'win32') {
        // Windows
        exec(`netstat -ano | findstr :${port}`, (error, stdout, stderr) => {
            if (error) {
                console.log(`Port ${port} is free`);
                return;
            }
            
            if (stdout) {
                const lines = stdout.trim().split('\n');
                const pids = new Set();
                
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 5) {
                        const pid = parts[parts.length - 1];
                        if (pid && pid !== '0') {
                            pids.add(pid);
                        }
                    }
                });
                
                if (pids.size > 0) {
                    console.log(`Found ${pids.size} process(es) using port ${port}`);
                    
                    pids.forEach(pid => {
                        console.log(`   Killing PID: ${pid}`);
                        exec(`taskkill /PID ${pid} /F`, (killError, killStdout, killStderr) => {
                            if (killError) {
                                console.error(`   Failed to kill PID ${pid}:`, killError.message);
                            } else {
                                console.log(`   Successfully killed PID ${pid}`);
                            }
                        });
                    });
                    
                    setTimeout(() => {
                        console.log(`Port ${port} should now be free`);
                    }, 1000);
                } else {
                    console.log(`Port ${port} is free`);
                }
            } else {
                console.log(`Port ${port} is free`);
            }
        });
    } else {
        // Unix/Linux/macOS
        exec(`lsof -ti:${port}`, (error, stdout, stderr) => {
            if (error) {
                console.log(`Port ${port} is free`);
                return;
            }
            
            if (stdout) {
                const pids = stdout.trim().split('\n').filter(pid => pid);
                
                if (pids.length > 0) {
                    console.log(`Found ${pids.length} process(es) using port ${port}`);
                    
                    pids.forEach(pid => {
                        console.log(`   Killing PID: ${pid}`);
                        exec(`kill -9 ${pid}`, (killError) => {
                            if (killError) {
                                console.error(`   Failed to kill PID ${pid}:`, killError.message);
                            } else {
                                console.log(`   Successfully killed PID ${pid}`);
                            }
                        });
                    });
                    
                    setTimeout(() => {
                        console.log(`Port ${port} should now be free`);
                    }, 1000);
                } else {
                    console.log(`Port ${port} is free`);
                }
            } else {
                console.log(`Port ${port} is free`);
            }
        });
    }
}

killPort(port);

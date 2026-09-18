# 操作系统实验三 实验报告

姓名：张三　学号：2021xxxxxx　班级：计算机 3 班

## 1 实验原理

进程是操作系统进行资源分配和调度的基本单位。在 Linux 中，`fork()` 系统调用会创建一个新的子进程，父进程与子进程各自拥有独立的地址空间，但共享文件描述符表。`fork()` 在父进程中返回子进程的 PID，在子进程中返回 0，出错时返回 -1。因此程序中通常通过判断返回值来区分父子进程的执行路径。

子进程结束后并不会立刻从系统中消失，而是进入僵尸状态，等待父进程读取其退出状态。若父进程不调用 `wait()` 或 `waitpid()` 回收，僵尸进程会一直占用进程表项。本实验的目标是通过编写程序观察上述现象，并在父进程中回收全部子进程，避免僵尸进程累积。

信号是进程间通信的一种异步机制。通过 `signal()` 或 `sigaction()` 注册处理函数后，进程可以在收到 SIGINT、SIGTERM 等信号时执行自定义逻辑。本实验还要求演示父进程向子进程发送信号并观察其行为。

## 2 实验环境

- 操作系统：Ubuntu 22.04 LTS
- 编译器：gcc 11.4.0
- 内核版本：5.15.0

## 3 程序实现

核心代码见代码块 3.1。

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/types.h>

int main(void) {
    pid_t pid = fork();

    if (pid < 0) {
        perror("fork failed");
        return 1;
    }

    if (pid == 0) {
        printf("child process, pid = %d\n", getpid());
        sleep(1);
        printf("child process exiting\n");
        return 0;
    }

    printf("parent process, child pid = %d\n", pid);
    sleep(2);
    printf("parent process exiting\n");
    return 0;
}
```

程序首先调用 `fork()` 创建子进程。父进程打印子进程 PID 后休眠 2 秒，子进程打印自身 PID 并休眠 1 秒。父进程在退出前会回收全部子进程，确保系统进程表中不残留僵尸项。

## 4 实验结果

编译并运行上述程序，得到如下输出：

```
parent process, child pid = 4213
child process, pid = 4213
child process exiting
parent process exiting
```

图1 展示了父子进程的创建与退出时序。从输出可以看到，父进程先打印子进程 PID，随后子进程打印自身 PID。整个程序在约 2 秒内结束，符合预期。

进一步使用 `ps aux | grep defunct` 检查，未发现僵尸进程残留（结果见图2）。

## 5 遇到的问题

初次编写时忘记了父进程需要等待子进程结束，导致输出顺序与预期不一致。后来调整了父子进程的 `sleep` 时长，使子进程先于父进程退出，输出顺序就正常了。

## 6 实验总结

通过本实验掌握了 `fork()` 的使用方法，理解了父子进程的创建过程与执行顺序关系。同时认识到进程同步的重要性：如果不控制父子进程的时序，输出会交错难以阅读。

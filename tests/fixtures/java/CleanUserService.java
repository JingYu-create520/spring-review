package com.example.demo.service;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.example.demo.mapper.UserMapper;
import com.example.demo.model.User;
import com.example.demo.writer.UserAuditWriter;

/**
 * 规范写法。这个文件必须产出 0 findings —— 误报是这类工具的口碑杀手,
 * 它同时也是 SPR001/002/003/004/005/006 与 MYB002 的负例守卫。
 */
@Service
public class CleanUserService {

    private final UserMapper userMapper;

    private final UserAuditWriter userAuditWriter;

    /** 注入的线程池 Bean,而不是方法里 new 出来的。 */
    private final org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor notifyExecutor;

    /** 线程安全类型。 */
    private final Map<String, Integer> counter = new ConcurrentHashMap<>();

    /** 跨 Bean 调用:走代理,事务/@Async 通知都生效。 */
    public User rename(Long id, String name) {
        userAuditWriter.updateName(id, name);
        return userMapper.selectById(id);
    }

    /** 显式 rollbackFor,受检异常也会回滚。 */
    @Transactional(rollbackFor = Exception.class)
    public void importUsers(List<User> users) throws IOException {
        userAuditWriter.insertAll(users);
    }

    /** @Async 方法在别的 Bean 上,这里只调用它。 */
    public void dispatch(String payload) {
        userAuditWriter.notifyLater(payload);
    }

    /** @Scheduled 无参、public,且在独立组件里。 */
    @Transactional
    public void nightly() {
        userMapper.purgeAllTenants();
    }

    /** 任务提交到注入的线程池。 */
    public void refreshAsync() {
        notifyExecutor.execute(() -> userMapper.refresh());
    }

    /** 计数写在线程安全类型上。 */
    public int bump(String key) {
        counter.merge(key, 1, Integer::sum);
        return counter.size();
    }

    /** 显式 SpEL key,单参数。 */
    @Cacheable(cacheNames = "user", key = "#userId")
    public User findUser(Long userId) {
        return userMapper.selectById(userId);
    }

    /** 一次 IN 批量查询后在内存组装,没有 N+1。 */
    public Map<Long, User> loadAll(List<Long> ids) {
        return userMapper.selectByIds(ids).stream()
            .collect(Collectors.toMap(User::getId, user -> user));
    }

    /** 组装结果时不再查库。 */
    public List<String> namesOf(List<Long> ids) {
        List<User> users = userMapper.selectByIds(ids);
        return users.stream().map(User::getName).toList();
    }

    /** Optional.map 只有一个元素,不是 N+1;真实网关代码里被误报过的形状。 */
    @Transactional
    public String renameIfPresent(Long id, String name) {
        return userMapper.selectByIdOptional(id).map(user -> {
            user.setName(name);
            return userMapper.updateName(user.getId(), name);
        }).orElse("");
    }
}

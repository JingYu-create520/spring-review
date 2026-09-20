package com.example.demo.service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.example.demo.mapper.DeptMapper;
import com.example.demo.mapper.UserMapper;
import com.example.demo.model.User;

/** 故意写坏的服务类:每条规则都要在这里命中。 */
@Service
public class BadUserService {

    @Autowired
    private UserMapper userMapper;

    @Autowired
    private DeptMapper deptMapper;

    private final Map<String, Integer> counter = new HashMap<>();

    private final List<User> buffer = new ArrayList<>();

    /** SPR001 —— 同类自调用绕过代理。 */
    public User rename(Long id, String name) {
        this.updateName(id, name);
        return userMapper.selectById(id);
    }

    @Transactional
    public void updateName(Long id, String name) {
        userMapper.updateName(id, name);
    }

    /** SPR002 —— 抛受检异常但没有 rollbackFor。 */
    @Transactional
    public void importUsers(List<User> users) throws IOException {
        for (User user : users) {
            userMapper.insertOne(user);
        }
    }

    /** SPR003 —— private @Async 不会被代理拦截。 */
    @Async
    private void drainQueue() {
        deptMapper.purgeQueue();
    }

    /** SPR003 —— public 但被同类直接调用。 */
    @Async
    public void notifyLater(String payload) {
        deptMapper.touch(payload);
    }

    /** SPR003 —— 同类内调用 @Async 方法。 */
    public void dispatch(String payload) {
        notifyLater(payload);
    }

    /** SPR003 —— @Scheduled 方法带参数。 */
    @Scheduled(cron = "0 0 * * * *")
    public void nightly(String tenant) {
        userMapper.purge(tenant);
    }

    /** SPR004 —— 请求路径里新建线程池。 */
    public void refreshAsync() {
        Executors.newFixedThreadPool(8).execute(() -> userMapper.refresh());
        new Thread(() -> userMapper.warm()).start();
    }

    /** SPR005 —— 单例可变状态被非同步方法写。 */
    public int bump(String key) {
        counter.merge(key, 1, Integer::sum);
        buffer.add(userMapper.selectById(1L));
        return counter.size();
    }

    /** SPR006 —— 多参数未指定 key;同时被自调用。 */
    @Cacheable(cacheNames = "user")
    public User findUser(Long tenantId, Long userId) {
        return userMapper.selectByKey(tenantId, userId);
    }

    public User lookup(Long tenantId, Long userId) {
        return this.findUser(tenantId, userId);
    }

    /** MYB002 —— 循环里逐条查。 */
    public List<User> loadAll(List<Long> ids) {
        List<User> result = new ArrayList<>();
        for (Long id : ids) {
            result.add(userMapper.selectById(id));
        }
        ids.forEach(id -> result.add(deptMapper.selectUser(id)));
        return result;
    }
}
